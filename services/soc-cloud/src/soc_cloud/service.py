from __future__ import annotations

import asyncio
import uuid

import websockets

import soc_log
from soc_cloud.settings import SERVICE, Settings
from soc_db import Database
from soc_realtime import RealtimeSocket
from soc_realtime.socket import Connector
from soc_supervision.endpoint import application, serve

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
            {"database": lambda: self.database.health, "realtime": lambda: self.realtime.health},
        )
        async with asyncio.TaskGroup() as group:
            group.create_task(self.database.run())
            group.create_task(self.realtime.run())
            group.create_task(serve(health, self.settings.health_port, self._health_host))
