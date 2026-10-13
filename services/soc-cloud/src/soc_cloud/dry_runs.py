"""Dry runs of flight files: a stack judges a file it keeps nowhere (FR-LNK-09, IR-DRY).

soc-operations asks for a dry run by inserting its row in soc.dry_runs, which announces it
with pg_notify when it commits. Each pending run is judged by the stack its gateway belongs
to: the file's bytes and its wayline's takeoff go to that stack's wayline API, and
soc.record_dry_run records the verdict, valid or rejected as SO judged it with every problem
it named, or failed with what went wrong. A run for a stack this service does not serve is
failed with that reason.

Every connection sweeps the pending runs, so one announced while the service was away is
judged then, and a run announced twice is judged once. A verdict the database is busy or away
for is kept and recorded when it can be; the stack is not asked again for it.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol

import asyncpg
import msgspec

import soc_log
from soc_cloud.presence import AWAY
from soc_cloud.so_api import SoApiError, Validation, Verdict
from soc_cloud.stacks import RETRY_S, TRANSIENT
from soc_db import Database

CHANNEL = "soc_dry_runs"
PENDING = "select id from soc.dry_runs where status = 'pending' order by requested_at"
REQUEST = """
select s.name, f.bytes, w.takeoff
  from soc.dry_runs d
  join soc.stacks s on s.gateway_sn = d.gateway_sn
  join soc.flight_files f on f.id = d.file_id
  join soc.waylines w on w.id = f.wayline_id
 where d.id = $1 and d.status = 'pending'
"""
JUDGE = "select * from soc.record_dry_run($1, $2::soc.dry_run_status, $3::jsonb)"

Outcome = Literal["valid", "rejected", "failed"]

log = soc_log.get(__name__)


@dataclass(frozen=True)
class Request:
    """A pending run: the stack that judges it, the file's bytes, and the takeoff as SoApi
    takes it, (latitude_deg, longitude_deg). The database keeps it [longitude, latitude]."""

    stack: str
    kmz: bytes = field(repr=False)
    takeoff: tuple[float, float]


class ValidationApi(Protocol):
    """The judgement of a flight file; so_api.SoApi is one."""

    async def validate(self, kmz: bytes, *, takeoff: tuple[float, float] | None) -> Validation: ...


class DryRunStore(Protocol):
    async def pending(self) -> list[uuid.UUID]: ...

    async def get(self, run: uuid.UUID) -> Request | None: ...

    async def judge(self, run: uuid.UUID, outcome: Outcome, verdict: str) -> None: ...


class PostgresDryRunStore:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def pending(self) -> list[uuid.UUID]:
        async with self._database.session() as connection:
            rows = await connection.fetch(PENDING)
        return [row["id"] for row in rows]

    async def get(self, run: uuid.UUID) -> Request | None:
        async with self._database.session() as connection:
            row = await connection.fetchrow(REQUEST, run)
        if row is None:
            return None
        longitude, latitude = json.loads(row["takeoff"])
        return Request(
            stack=row["name"],
            kmz=bytes(row["bytes"]),
            takeoff=(float(latitude), float(longitude)),
        )

    async def judge(self, run: uuid.UUID, outcome: Outcome, verdict: str) -> None:
        async with self._database.session() as connection:
            await connection.execute(JUDGE, run, outcome, verdict)


class DryRuns:
    def __init__(self, store: DryRunStore, *, retry_s: float = RETRY_S) -> None:
        self._store = store
        self._retry_s = retry_s
        self._queue: asyncio.Queue[uuid.UUID] = asyncio.Queue()
        self._judging: set[uuid.UUID] = set()

    async def announced(self, payload: str) -> None:
        """Queues an announced run: the listener returns at once, the judging runs in `run`."""
        try:
            run = uuid.UUID(payload)
        except ValueError:
            log.warning("dry_run_announcement_unreadable", payload=payload)
            return
        self._queue.put_nowait(run)

    async def sweep(self) -> None:
        """Queues every pending run; a sweep the database is away for is found by the next one."""
        try:
            pending = await self._store.pending()
        except (*AWAY, asyncpg.PostgresError) as error:
            log.warning("dry_runs_sweep_missed", error=str(error))
            return
        for run in pending:
            self._queue.put_nowait(run)
        log.info("dry_runs_swept", pending=len(pending))

    async def run(self, apis: Mapping[str, ValidationApi]) -> None:
        async with asyncio.TaskGroup() as group:
            while True:
                run = await self._queue.get()
                if run in self._judging:
                    continue
                self._judging.add(run)
                group.create_task(self._judge(run, apis))

    async def _judge(self, run: uuid.UUID, apis: Mapping[str, ValidationApi]) -> None:
        try:
            request = await self._patiently(lambda: self._store.get(run))
            if request is None:
                return
            outcome, verdict = await self._verdict(run, request, apis)
            await self._patiently(lambda: self._store.judge(run, outcome, verdict))
        except asyncpg.PostgresError as refusal:
            log.error("dry_run_refused", run=str(run), error=str(refusal))
        finally:
            self._judging.discard(run)

    async def _verdict(
        self, run: uuid.UUID, request: Request, apis: Mapping[str, ValidationApi]
    ) -> tuple[Outcome, str]:
        api = apis.get(request.stack)
        if api is None:
            return _failed(run, f"stack {request.stack} is not served by this soc-cloud")
        try:
            validation = await api.validate(request.kmz, takeoff=request.takeoff)
        except (SoApiError, ValueError) as error:
            return _failed(run, str(error))
        outcome: Outcome = "valid" if validation.status is Verdict.VALID else "rejected"
        log.info("dry_run_judged", run=str(run), outcome=outcome)
        return outcome, msgspec.json.encode(validation).decode()

    async def _patiently[T](self, work: Callable[[], Awaitable[T]]) -> T:
        """Tries again while the database is away or busy, so a verdict is recorded once."""
        while True:
            try:
                return await work()
            except TRANSIENT:
                await asyncio.sleep(self._retry_s)


def _failed(run: uuid.UUID, reason: str) -> tuple[Outcome, str]:
    log.warning("dry_run_failed", run=str(run), error=reason)
    return "failed", msgspec.json.encode({"error": reason}).decode()
