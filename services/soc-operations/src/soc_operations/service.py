from __future__ import annotations

import asyncio

import soc_log
from soc_operations.judging import judged
from soc_operations.runner import Runner
from soc_operations.settings import SERVICE, Settings
from soc_supervision.endpoint import application, serve

log = soc_log.get(__name__)


class OperationsService:
    def __init__(self, settings: Settings, *, bind_host: str | None = None) -> None:
        self.settings = settings
        self.runner = Runner(settings.database, settings.tunables, judged)
        self.database = self.runner.database
        self._bind_host = bind_host

    async def run(self) -> None:
        log.info(
            "service_started",
            fingerprint=self.settings.fingerprint,
            contract_version=self.settings.contract_version,
            organizations=len(self.settings.tunables.served_organizations),
        )
        health = application(SERVICE, {"database": lambda: self.database.health})
        async with asyncio.TaskGroup() as group:
            group.create_task(self.runner.run())
            group.create_task(serve(health, self.settings.health_port, self._bind_host))
