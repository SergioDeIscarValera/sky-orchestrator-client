from __future__ import annotations

import asyncio
import functools
import uuid

import websockets

import soc_log
from soc_cloud.commands import CHANNEL, Commands, PostgresCommandStore
from soc_cloud.files import FileServer, FlightFiles
from soc_cloud.link.stack import StackLink
from soc_cloud.link.telemetry import Sample
from soc_cloud.presence import PostgresPresenceStore, PresenceRecorder
from soc_cloud.settings import SERVICE, Settings
from soc_cloud.wire import WireContract
from soc_db import Database
from soc_realtime import RealtimeSocket
from soc_realtime.socket import Connector
from soc_supervision.endpoint import HealthSource, application, serve

log = soc_log.get(__name__)


def telemetry_topic(organization: uuid.UUID) -> str:
    return f"org:{organization}:soc:telemetry"


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
            listeners={CHANNEL: self._announced},
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
        )
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
        async with asyncio.TaskGroup() as group:
            group.create_task(self.database.run())
            group.create_task(self.realtime.run())
            group.create_task(self.presence.run())
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

    async def _announced(self, payload: str) -> None:
        await self.commands.announced(payload)

    async def _connected(self) -> None:
        self.presence.rewrite_all()
        await self.commands.sweep()

    def _replied(self, tid: str, result: int) -> None:
        self.commands.replied(tid, result)

    def _dock_announced(self, gateway: str) -> None:
        self.commands.announced_gateway(gateway)


def _health_of(link: StackLink) -> HealthSource:
    return lambda: link.health
