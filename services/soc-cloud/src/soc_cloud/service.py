from __future__ import annotations

import asyncio
import functools

import aiohttp
import websockets

import soc_log
from soc_cloud.commands import CHANNEL, Commands, Intent, PostgresCommandStore
from soc_cloud.dry_runs import CHANNEL as DRY_RUNS_CHANNEL
from soc_cloud.dry_runs import DryRuns, PostgresDryRunStore
from soc_cloud.fanout import Fanout, telemetry_topic
from soc_cloud.files import FileServer, FlightFiles
from soc_cloud.flights import FlightWatch, PostgresFlightStore
from soc_cloud.latency import Latencies
from soc_cloud.link.progress import FlightProgress
from soc_cloud.link.stack import StackLink
from soc_cloud.link.telemetry import Sample
from soc_cloud.presence import PostgresPresenceStore, PresenceRecorder
from soc_cloud.settings import SERVICE, Settings
from soc_cloud.so_api import SoApi
from soc_cloud.stacks import PostgresStackStore, StackSource, StackWatcher
from soc_cloud.wire import WireContract
from soc_db import Database
from soc_realtime import Broadcaster, HttpBroadcast, RealtimeSocket
from soc_realtime.socket import Connector
from soc_supervision.endpoint import HealthSource, application, serve

log = soc_log.get(__name__)
# Bounds one call to a stack's wayline API. A status or envelope read is bounded by its own
# interval as well; a validation uploads a flight file and waits for Sky Orchestrator's judgement.
WAYLINE_TIMEOUT_S = 30.0


class CloudService:
    def __init__(
        self,
        settings: Settings,
        *,
        realtime_connector: Connector = websockets.connect,
        bind_host: str | None = None,
    ) -> None:
        self.settings = settings
        self.database = Database(
            settings.database,
            listeners={CHANNEL: self._announced, DRY_RUNS_CHANNEL: self._dry_run_announced},
            on_connected=self._connected,
        )
        self.realtime = RealtimeSocket(
            settings.realtime,
            [
                telemetry_topic(organization)
                for organization in settings.tunables.served_organizations
            ],
            connector=realtime_connector,
        )
        self.wire = WireContract()
        self.presence = PresenceRecorder(PostgresPresenceStore(self.database))
        self.latencies = Latencies()
        self.fanout = Fanout(
            {stack.name: stack.organization for stack in settings.tunables.stacks},
            settings.tunables.broadcast_max_rate_hz,
            latencies=self.latencies,
        )
        self.latest: dict[str, Sample] = {}
        self.files = FlightFiles(
            {stack.name: stack.flight_files_url for stack in settings.tunables.stacks},
            grace_s=settings.tunables.flight_file_grace_s,
        )
        self.file_server = FileServer(self.files)
        self.links = [
            StackLink(
                stack,
                settings.credentials[stack.name],
                self.wire,
                on_sample=self._sampled,
                files=functools.partial(self.files.offer, stack.name),
                on_reply=self._replied,
                on_announced=self._dock_announced,
                on_progress=self._progressed,
                on_presence=self._presence_changed,
                presence=self.presence.for_stack(stack.name, stack.organization),
            )
            for stack in settings.tunables.stacks
        ]
        self.commands = Commands(
            PostgresCommandStore(self.database),
            self.links,
            self.wire,
            ttl_s=settings.tunables.command_intent_ttl_s,
            reply_timeout_s=settings.tunables.command_reply_timeout_s,
            latencies=self.latencies,
            on_prepare=self._preparing,
            on_settled=self._settled,
        )
        self.flights = FlightWatch(
            PostgresFlightStore(self.database),
            self.files,
            self.commands,
            stale_after_ms=settings.tunables.telemetry_stale_after_ms,
            warning_band_m=settings.tunables.geofence_warning_band_m,
            batch_s=settings.tunables.telemetry_batch_s,
            latencies=self.latencies,
        )
        self.stack_watcher = StackWatcher(
            [
                StackSource(link.stack.name, link.stack.flight_files_url, link.topology.gateways)
                for link in self.links
            ],
            PostgresStackStore(self.database),
            status_poll_ms=settings.tunables.stack_status_poll_ms,
            envelope_poll_s=settings.tunables.stack_envelope_poll_s,
        )
        self.dry_runs = DryRuns(PostgresDryRunStore(self.database))
        self._bind_host = bind_host

    async def run(self) -> None:
        log.info(
            "service_started",
            fingerprint=self.settings.fingerprint,
            contract_version=self.settings.contract_version,
            stacks=[stack.name for stack in self.settings.tunables.stacks],
            organizations=len(self.settings.tunables.served_organizations),
        )
        health = application(
            SERVICE,
            {
                "database": lambda: self.database.health,
                "realtime": lambda: self.realtime.health,
                "flight_files": lambda: self.file_server.health,
                **{f"stack:{link.stack.name}": _health_of(link) for link in self.links},
            },
        )
        async with aiohttp.ClientSession() as http, asyncio.TaskGroup() as group:
            broadcaster = Broadcaster(self.realtime, HttpBroadcast(self.settings.realtime, http))
            apis = {
                stack.name: SoApi(
                    http,
                    stack.api.url,
                    self.settings.credentials[stack.name].api_token,
                    timeout_s=WAYLINE_TIMEOUT_S,
                )
                for stack in self.settings.tunables.stacks
            }
            group.create_task(self.database.run())
            group.create_task(self.realtime.run())
            group.create_task(self.presence.run())
            group.create_task(self.fanout.run(broadcaster))
            group.create_task(self.latencies.run())
            group.create_task(self.flights.run())
            group.create_task(self.stack_watcher.run(apis))
            group.create_task(self.dry_runs.run(apis))
            for link in self.links:
                group.create_task(link.run())
            group.create_task(serve(health, self.settings.health_port, self._bind_host))
            group.create_task(
                serve(
                    self.file_server.application(),
                    self.settings.flight_files_port,
                    self._bind_host,
                )
            )

    def _sampled(self, sample: Sample) -> None:
        self.latest[sample.aircraft] = sample
        self.flights.sampled(sample)
        self.fanout.sampled(sample)

    def _progressed(self, progress: FlightProgress) -> None:
        self.flights.progressed(progress)

    def _presence_changed(self, aircraft: str, online: bool) -> None:
        self.flights.presence(aircraft, online)

    async def _preparing(self, intent: Intent) -> bool:
        return await self.flights.preparing(intent)

    def _settled(self, intent: Intent, result: int) -> None:
        self.flights.settled(intent, result)

    async def _announced(self, payload: str) -> None:
        await self.commands.announced(payload)

    async def _dry_run_announced(self, payload: str) -> None:
        await self.dry_runs.announced(payload)

    async def _connected(self) -> None:
        self.presence.rewrite_all()
        # The flights first: a prepare the commands' sweep sends finds its file kept.
        await self.flights.sweep()
        await self.commands.sweep()
        await self.dry_runs.sweep()

    def _replied(self, tid: str, result: int) -> None:
        self.commands.replied(tid, result)

    def _dock_announced(self, gateway: str) -> None:
        self.commands.announced_gateway(gateway)


def _health_of(link: StackLink) -> HealthSource:
    return lambda: link.health
