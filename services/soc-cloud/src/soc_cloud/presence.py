"""What each stack reports, recorded for the console (FR-FLE-02, FR-LNK-02, IR-STK, IR-DEV).

The stack links report synchronously; the recorder keeps only the latest of each
stack's link, each gateway's devices and each aircraft's firmware, and writes
what changed through soc-cloud's database functions, stacks before the devices
that hang on them. When the database is away it keeps everything, and when it
comes back it writes everything again, so the console never shows a state SOC
left behind.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

import asyncpg

import soc_log
from soc_db import Database, DatabaseUnavailableError

RETRY_S = 1.0
# The connection lost in the middle of a statement: written again when it is back.
AWAY = (DatabaseUnavailableError, OSError, asyncpg.InterfaceError)

log = soc_log.get(__name__)


class LinkState(StrEnum):
    CONNECTED = "connected"
    CONNECTING = "connecting"
    DISPLACED = "displaced"
    UNREACHABLE = "unreachable"


@dataclass(frozen=True)
class Device:
    aircraft_sn: str
    domain: int
    type: int
    sub_type: int
    online: bool


@dataclass(frozen=True)
class StackReport:
    gateway: str
    stack: str
    organization: uuid.UUID
    state: LinkState


class Presence(Protocol):
    """What a stack link tells about its stack."""

    def link(self, gateway: str, state: LinkState) -> None: ...

    def topology(self, gateway: str, devices: Sequence[Device]) -> None: ...

    def firmware(self, gateway: str, aircraft: str, version: str) -> None: ...


class NoPresence:
    def link(self, gateway: str, state: LinkState) -> None:
        pass

    def topology(self, gateway: str, devices: Sequence[Device]) -> None:
        pass

    def firmware(self, gateway: str, aircraft: str, version: str) -> None:
        pass


class PresenceStore(Protocol):
    async def record_stack(self, report: StackReport) -> None: ...

    async def record_topology(self, gateway: str, devices: Sequence[Device]) -> int: ...

    async def record_firmware(self, gateway: str, aircraft: str, version: str) -> None: ...


class PostgresPresenceStore:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def record_stack(self, report: StackReport) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_stack($1, $2, $3, $4)",
                report.gateway,
                report.stack,
                report.organization,
                report.state.value,
            )

    async def record_topology(self, gateway: str, devices: Sequence[Device]) -> int:
        announced = [
            {
                "aircraft_sn": device.aircraft_sn,
                "domain": device.domain,
                "type": device.type,
                "sub_type": device.sub_type,
                "online": device.online,
            }
            for device in devices
        ]
        async with self._database.session() as connection:
            online: int = await connection.fetchval(
                "select soc.record_topology($1, $2::jsonb)", gateway, json.dumps(announced)
            )
        return online

    async def record_firmware(self, gateway: str, aircraft: str, version: str) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_firmware($1, $2, $3)", gateway, aircraft, version
            )


class PresenceRecorder:
    def __init__(self, store: PresenceStore, *, retry_s: float = RETRY_S) -> None:
        self._store = store
        self._retry_s = retry_s
        self._stacks: dict[str, StackReport] = {}
        self._topologies: dict[str, tuple[Device, ...]] = {}
        self._firmware: dict[tuple[str, str], str] = {}
        self._dirty: set[tuple[str, ...]] = set()
        self._changed = asyncio.Event()

    def for_stack(self, stack: str, organization: uuid.UUID) -> Presence:
        return _StackPresence(self, stack, organization)

    def record_stack(self, report: StackReport) -> None:
        if self._stacks.get(report.gateway) != report:
            self._stacks[report.gateway] = report
            self._mark(("stack", report.gateway))

    def record_topology(self, gateway: str, devices: Sequence[Device]) -> None:
        snapshot = tuple(devices)
        if self._topologies.get(gateway) != snapshot:
            self._topologies[gateway] = snapshot
            self._mark(("topology", gateway))

    def record_firmware(self, gateway: str, aircraft: str, version: str) -> None:
        if self._firmware.get((gateway, aircraft)) != version:
            self._firmware[(gateway, aircraft)] = version
            self._mark(("firmware", gateway, aircraft))

    def rewrite_all(self) -> None:
        """After the database comes back: everything known is written again."""
        self._dirty |= {("stack", gateway) for gateway in self._stacks}
        self._dirty |= {("topology", gateway) for gateway in self._topologies}
        self._dirty |= {("firmware", *key) for key in self._firmware}
        self._changed.set()

    async def run(self) -> None:
        while True:
            await self._changed.wait()
            self._changed.clear()
            if not await self.flush():
                await asyncio.sleep(self._retry_s)
                self._changed.set()

    async def flush(self) -> bool:
        """Writes what changed, stacks first; False when the database is away.

        A device waits for its stack's row. What the database refuses (a serial
        it does not accept, a stack moved to another organization while it has
        fleets) is logged and dropped rather than retried forever.
        """
        for item in sorted(self._dirty, key=_written_before):
            if item[0] != "stack" and item[1] not in self._stacks:
                continue
            self._dirty.discard(item)
            try:
                await self._write(item)
            except AWAY:
                self._dirty.add(item)
                return False
            except asyncpg.PostgresError as refusal:
                log.error("presence_refused", item=list(item), error=str(refusal))
        return True

    async def _write(self, item: tuple[str, ...]) -> None:
        kind, gateway = item[0], item[1]
        if kind == "stack":
            await self._store.record_stack(self._stacks[gateway])
        elif kind == "topology":
            online = await self._store.record_topology(gateway, self._topologies[gateway])
            log.info("topology_recorded", gateway=gateway, online=online)
        else:
            aircraft = item[2]
            await self._store.record_firmware(
                gateway, aircraft, self._firmware[(gateway, aircraft)]
            )

    def _mark(self, item: tuple[str, ...]) -> None:
        self._dirty.add(item)
        self._changed.set()


ORDER = {"stack": 0, "topology": 1, "firmware": 2}


def _written_before(item: tuple[str, ...]) -> tuple[int, tuple[str, ...]]:
    return ORDER[item[0]], item


@dataclass(frozen=True)
class _StackPresence:
    recorder: PresenceRecorder
    stack: str
    organization: uuid.UUID

    def link(self, gateway: str, state: LinkState) -> None:
        self.recorder.record_stack(StackReport(gateway, self.stack, self.organization, state))

    def topology(self, gateway: str, devices: Sequence[Device]) -> None:
        self.recorder.record_topology(gateway, devices)

    def firmware(self, gateway: str, aircraft: str, version: str) -> None:
        self.recorder.record_firmware(gateway, aircraft, version)
