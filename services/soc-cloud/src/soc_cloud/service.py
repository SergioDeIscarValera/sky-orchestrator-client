from __future__ import annotations

import asyncio
import uuid

import websockets

import soc_log
from soc_cloud.link.stack import StackLink
from soc_cloud.link.telemetry import Sample
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
        health_host: str | None = None,
    ) -> None:
        self.settings = settings
        self.database = Database(settings.database)
        self.realtime = RealtimeSocket(
            settings.realtime,
            [
                telemetry_topic(organization)
                for organization in settings.tunables.served_organizations
            ],
            connector=realtime_connector,
        )
        self.wire = WireContract()
        self.latest: dict[str, Sample] = {}
        self.links = [
            StackLink(stack, settings.credentials[stack.name], self.wire, on_sample=self._sampled)
            for stack in settings.tunables.stacks
        ]
        self._health_host = health_host

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
                **{f"stack:{link.stack.name}": _health_of(link) for link in self.links},
            },
        )
        async with asyncio.TaskGroup() as group:
            group.create_task(self.database.run())
            group.create_task(self.realtime.run())
            for link in self.links:
                group.create_task(link.run())
            group.create_task(serve(health, self.settings.health_port, self._health_host))

    def _sampled(self, sample: Sample) -> None:
        self.latest[sample.aircraft] = sample


def _health_of(link: StackLink) -> HealthSource:
    return lambda: link.health
