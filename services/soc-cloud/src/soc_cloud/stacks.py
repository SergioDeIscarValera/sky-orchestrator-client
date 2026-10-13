"""The stacks' status, envelope and flight-file address, recorded (FR-LNK-08, FR-LNK-09, ADR-0025).

Each stack's status and envelope are read on their own cadence, `stack_status_poll_ms` and
`stack_envelope_poll_s`, each stack and each kind on its own task, so one stack that answers
slowly delays no other. A read that fails, or gives no answer within its interval, is recorded
as unknown (null): an unknown stays unknown, never the last value read (FR-LNK-08). Each reading
is written for every gateway the stack's link has heard, through soc.record_stack_status and
soc.record_stack_envelope, which keep when it was read.

The stack's flight-file address is recorded once for each such gateway, then read back: the
database does nothing when the stack's row is not there yet, so a record that did not show is
tried again with the next reading.

When the database is away only the latest reading of each is kept, and it is written when the
database is back, as presence.py does. A reading the database refuses is logged and dropped.
"""

from __future__ import annotations

import asyncio
import itertools
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

import asyncpg
import msgspec

import soc_log
from soc_cloud.presence import AWAY
from soc_cloud.so_api import Envelope, SoApiError, StackStatus
from soc_db import Database

RETRY_S = 1.0
# Away, or a statement that waited out its lock_timeout or its statement_timeout: kept and
# written again, the latest reading still the one written.
TRANSIENT = (*AWAY, asyncpg.LockNotAvailableError, asyncpg.QueryCanceledError)

log = soc_log.get(__name__)


class Kind(StrEnum):
    STATUS = "status"
    ENVELOPE = "envelope"


class StackApi(Protocol):
    """The reads of a stack's wayline API; so_api.SoApi is one."""

    async def status(self) -> StackStatus: ...

    async def envelope(self) -> Envelope: ...


class StackStore(Protocol):
    async def record_files_url(self, gateway: str, url: str) -> None: ...

    async def files_url(self, gateway: str) -> str | None: ...

    async def record_status(self, gateway: str, status: str | None) -> None: ...

    async def record_envelope(self, gateway: str, envelope: str | None) -> None: ...


class PostgresStackStore:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def record_files_url(self, gateway: str, url: str) -> None:
        async with self._database.session() as connection:
            await connection.execute("select soc.record_stack_files_url($1, $2)", gateway, url)

    async def files_url(self, gateway: str) -> str | None:
        async with self._database.session() as connection:
            url: str | None = await connection.fetchval(
                "select flight_files_url from soc.stacks where gateway_sn = $1", gateway
            )
        return url

    async def record_status(self, gateway: str, status: str | None) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_stack_status($1, $2::jsonb)", gateway, status
            )

    async def record_envelope(self, gateway: str, envelope: str | None) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_stack_envelope($1, $2::jsonb)", gateway, envelope
            )


@dataclass(frozen=True)
class StackSource:
    """A configured stack as the watcher sees it: its name, its flight-file address, and the
    gateways its link has heard (the link's topology, which keeps every gateway once heard)."""

    name: str
    files_url: str
    gateways: Callable[[], Collection[str]]


@dataclass(frozen=True)
class Latest:
    version: int
    text: str | None


class StackRecorder:
    """The latest reading of each stack and kind, written for each gateway that has none yet."""

    def __init__(
        self, store: StackStore, sources: Sequence[StackSource], *, retry_s: float = RETRY_S
    ) -> None:
        self._store = store
        self._sources = list(sources)
        self._retry_s = retry_s
        self._latest: dict[tuple[str, Kind], Latest] = {}
        self._written: dict[tuple[str, Kind, str], int] = {}
        self._files: set[tuple[str, str]] = set()
        self._versions = itertools.count(1)
        self._changed = asyncio.Event()

    def reading(self, stack: str, kind: Kind, text: str | None) -> None:
        self._latest[(stack, kind)] = Latest(next(self._versions), text)
        self._changed.set()

    async def run(self) -> None:
        while True:
            await self._changed.wait()
            self._changed.clear()
            if not await self.flush():
                await asyncio.sleep(self._retry_s)
                self._changed.set()

    async def flush(self) -> bool:
        """Writes what is not written yet, for every gateway now known; False when the database
        is away."""
        for source in self._sources:
            for gateway in sorted(source.gateways()):
                try:
                    await self._record_files_url(source, gateway)
                    for kind in Kind:
                        await self._record_latest(source.name, kind, gateway)
                except TRANSIENT:
                    return False
        return True

    async def _record_files_url(self, source: StackSource, gateway: str) -> None:
        if (source.name, gateway) in self._files:
            return
        try:
            await self._store.record_files_url(gateway, source.files_url)
            read_back = await self._store.files_url(gateway)
        except TRANSIENT:
            raise
        except asyncpg.PostgresError as refusal:
            log.error(
                "stack_files_url_refused", stack=source.name, gateway=gateway, error=str(refusal)
            )
            self._files.add((source.name, gateway))
            return
        if read_back == source.files_url:
            self._files.add((source.name, gateway))
            log.info("stack_files_url_recorded", stack=source.name, gateway=gateway)

    async def _record_latest(self, stack: str, kind: Kind, gateway: str) -> None:
        latest = self._latest.get((stack, kind))
        key = (stack, kind, gateway)
        if latest is None or self._written.get(key) == latest.version:
            return
        try:
            await self._write(kind, gateway, latest.text)
        except TRANSIENT:
            raise
        except asyncpg.PostgresError as refusal:
            log.error(
                "stack_reading_refused",
                stack=stack,
                kind=kind.value,
                gateway=gateway,
                error=str(refusal),
            )
        self._written[key] = latest.version

    async def _write(self, kind: Kind, gateway: str, text: str | None) -> None:
        if kind is Kind.STATUS:
            await self._store.record_status(gateway, text)
        else:
            await self._store.record_envelope(gateway, text)


class StackWatcher:
    """Reads every configured stack's status and envelope on their own cadence, and records them."""

    def __init__(
        self,
        sources: Sequence[StackSource],
        store: StackStore,
        *,
        status_poll_ms: float,
        envelope_poll_s: float,
        retry_s: float = RETRY_S,
    ) -> None:
        self._sources = list(sources)
        self._recorder = StackRecorder(store, self._sources, retry_s=retry_s)
        self._status_poll_s = status_poll_ms / 1000
        self._envelope_poll_s = float(envelope_poll_s)
        self._reachable: dict[tuple[str, Kind], bool] = {}

    async def run(self, apis: Mapping[str, StackApi]) -> None:
        async with asyncio.TaskGroup() as group:
            group.create_task(self._recorder.run())
            for source in self._sources:
                api = apis[source.name]
                group.create_task(self._poll(source.name, api, Kind.STATUS, self._status_poll_s))
                group.create_task(
                    self._poll(source.name, api, Kind.ENVELOPE, self._envelope_poll_s)
                )

    async def _poll(self, stack: str, api: StackApi, kind: Kind, every_s: float) -> None:
        while True:
            started = time.monotonic()
            text = await self._read(stack, api, kind, within_s=every_s)
            self._recorder.reading(stack, kind, text)
            await asyncio.sleep(max(0.0, every_s - (time.monotonic() - started)))

    async def _read(self, stack: str, api: StackApi, kind: Kind, *, within_s: float) -> str | None:
        try:
            async with asyncio.timeout(within_s):
                answer = await (api.status() if kind is Kind.STATUS else api.envelope())
        except SoApiError as failure:
            self._reachability(stack, kind, reachable=False, error=str(failure))
            return None
        except TimeoutError:
            self._reachability(
                stack, kind, reachable=False, error=f"no answer within {within_s:g} s"
            )
            return None
        self._reachability(stack, kind, reachable=True)
        return msgspec.json.encode(answer).decode()

    def _reachability(
        self, stack: str, kind: Kind, *, reachable: bool, error: str | None = None
    ) -> None:
        """Logs a change of reachability only, never every read."""
        if self._reachable.get((stack, kind)) == reachable:
            return
        self._reachable[(stack, kind)] = reachable
        if reachable:
            log.info("stack_api_reachable", stack=stack, endpoint=kind.value)
        else:
            log.warning("stack_api_unreachable", stack=stack, endpoint=kind.value, error=error)
