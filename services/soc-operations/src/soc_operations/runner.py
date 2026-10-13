"""soc-operations at work: what it hears, in the order it hears it (ADR-0006, ADR-0025).

The database announces each thing soc-operations must act on, and a reconnection's sweep
finds what was announced while it was away:

- a member's transition request (`soc_transition_requests`) is claimed once, in its own
  transaction, then decided and applied in another. A decision that fails ends the request
  failed with the error, never claimed again; a request left running by a crash is closed
  failed by the next sweep;
- a command that settled (`soc_command_outcomes`) and a flight's progress
  (`soc_flight_progress`) move the operation they belong to;
- an aircraft's sample, a stack's status or envelope, a dry run's verdict
  (`soc_aircraft_samples`, `soc_stack_views`, `soc_dry_run_results`) have the checks of
  the operations they concern judged again, which may make a simulated operation ready or
  no longer ready (FR-OPS-04, FR-OPS-07);
- every second the checks of every operation preparing, simulated or ready are judged
  again, so a value growing old turns its check to unknown (FR-SAF-02); and every
  operation simulating or launching is looked at again, so an execute whose outcome
  stayed unknown with no progress since sends it back (DEP-27).

One worker applies one job at a time, so no two decisions race over an operation. Judging
is coalesced: an operation already waiting to be judged is not queued twice, so five
samples a second never pile up behind a slow query.
"""

from __future__ import annotations

import asyncio
import json
import math
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg

import soc_log
from soc_db import Database, DatabaseUnavailableError, Target
from soc_operations import lifecycle, store
from soc_operations.settings import Tunables

log = soc_log.get(__name__)

#: How often the checks of a preparing, simulated or ready operation are judged again.
TICK_S = 1.0
JUDGED = ("preparing", "simulated", "ready")
#: Waiting on a flight that may not have started (lifecycle.on_tick).
WAITING = ("simulating", "launching")
CONCERNS = ("soc_aircraft_samples", "soc_stack_views", "soc_dry_run_results")

type Judge = Callable[[store.Loaded, Tunables, datetime], Sequence[lifecycle.Check]]


@dataclass(frozen=True)
class Request:
    id: uuid.UUID


@dataclass(frozen=True)
class Outcome:
    id: uuid.UUID


@dataclass(frozen=True)
class Progress:
    flight_id: uuid.UUID


@dataclass(frozen=True)
class Concerns:
    channel: str
    key: str


@dataclass(frozen=True)
class JudgeOperation:
    operation_id: uuid.UUID


type Job = Request | Outcome | Progress | Concerns | JudgeOperation


class Runner:
    """The lifecycle's executor: one database connection, one worker, one tick."""

    def __init__(
        self,
        target: Target,
        tunables: Tunables,
        judge: Judge,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        tick_s: float = TICK_S,
    ) -> None:
        self._tunables = tunables
        self._judge = judge
        self._clock = clock
        self._tick_s = tick_s
        self._jobs: asyncio.Queue[Job] = asyncio.Queue()
        self._waiting: set[uuid.UUID] = set()
        listeners = {
            "soc_transition_requests": self._heard(lambda key: Request(uuid.UUID(key))),
            "soc_command_outcomes": self._heard(lambda key: Outcome(uuid.UUID(key))),
            "soc_flight_progress": self._heard(lambda key: Progress(uuid.UUID(key))),
            **{channel: self._concerns(channel) for channel in CONCERNS},
        }
        self.database = Database(target, listeners=listeners, on_connected=self._sweep)

    async def run(self) -> None:
        async with asyncio.TaskGroup() as group:
            group.create_task(self.database.run())
            group.create_task(self._work())
            group.create_task(self._tick())

    # --- Hearing --------------------------------------------------------------------------

    def _heard(self, job: Callable[[str], Job]) -> Callable[[str], Any]:
        async def enqueue(key: str) -> None:
            self._jobs.put_nowait(job(key))

        return enqueue

    def _concerns(self, channel: str) -> Callable[[str], Any]:
        async def enqueue(key: str) -> None:
            self._jobs.put_nowait(Concerns(channel, key))

        return enqueue

    def _judge_later(self, operation: uuid.UUID) -> None:
        if operation not in self._waiting:
            self._waiting.add(operation)
            self._jobs.put_nowait(JudgeOperation(operation))

    async def _sweep(self) -> None:
        """What was announced while away: requests still pending, operations still active."""
        async with self.database.transaction() as connection:
            # Left running by a crash: what was decided rolled back with it, so it failed.
            for row in await connection.fetch(
                "select id from soc.transition_requests where status = 'running'"
            ):
                await connection.execute(
                    "select * from soc.decide_transition_request($1, 'failed', $2::jsonb)",
                    row["id"], json.dumps(["soc-operations stopped while deciding it"]),
                )  # fmt: skip
            pending = await connection.fetch(
                "select id from soc.transition_requests where status = 'pending'"
                " order by requested_at"
            )
            active = await store.active(connection)
        for row in pending:
            self._jobs.put_nowait(Request(row["id"]))
        for operation in active:
            self._judge_later(operation)

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(self._tick_s)
            try:
                async with self.database.session() as connection:
                    rows = await connection.fetch(
                        "select id from soc.operations"
                        " where state = any($1::soc.operation_state[])",
                        [*JUDGED, *WAITING],
                    )
            except DatabaseUnavailableError:
                # The connection's own supervisor reports it; the next tick tries again.
                continue
            for row in rows:
                self._judge_later(row["id"])

    # --- Working --------------------------------------------------------------------------

    async def _work(self) -> None:
        while True:
            job = await self._jobs.get()
            try:
                await self._do(job)
            except Exception:
                log.exception("job_failed", job=repr(job))

    async def _do(self, job: Job) -> None:
        match job:
            case Request(id=request):
                await self._request(request)
            case Outcome(id=intent):
                await self._outcome(intent)
            case Progress(flight_id=flight):
                await self._progress(flight)
            case Concerns(channel=channel, key=key):
                async with self.database.session() as connection:
                    for operation in await store.operations_of(connection, channel, key):
                        self._judge_later(operation)
            case JudgeOperation(operation_id=operation):
                self._waiting.discard(operation)
                await self._judge_operation(operation)

    async def _request(self, request: uuid.UUID) -> None:
        async with self.database.transaction() as connection:
            claimed = await connection.fetchrow(
                "select * from soc.claim_transition_request($1, $2)",
                request, self._tunables.command_intent_ttl_s,
            )  # fmt: skip
        if claimed is None or claimed["status"] != "running":
            return
        operation, transition = claimed["operation_id"], claimed["transition"]
        try:
            async with self.database.transaction() as connection:
                loaded = await store.load(connection, operation)
                assert loaded is not None
                checks = self._judged(connection, loaded)
                await _record(connection, operation, checks)
                decision = lifecycle.on_request(loaded.snapshot, transition, checks)
                await store.apply(
                    connection, loaded, decision.actions, actor=claimed["requested_by"]
                )
                await connection.execute(
                    "select * from soc.decide_transition_request("
                    "$1, $2::soc.request_status, $3::jsonb)",
                    request,
                    "accepted" if decision.accepted else "refused",
                    None if decision.accepted else json.dumps(list(decision.reasons)),
                )
            log.info("transition_decided", operation=str(operation), transition=transition,
                     accepted=decision.accepted, reasons=list(decision.reasons))  # fmt: skip
        except Exception as failure:
            log.exception("transition_failed", operation=str(operation), transition=transition)
            async with self.database.transaction() as connection:
                await connection.execute(
                    "select * from soc.decide_transition_request($1, 'failed', $2::jsonb)",
                    request, json.dumps([f"soc-operations could not decide it: {failure}"]),
                )  # fmt: skip
        self._judge_later(operation)

    async def _outcome(self, intent: uuid.UUID) -> None:
        async with self.database.transaction() as connection:
            row = await connection.fetchrow(
                "select operation_id, flight_id, verb::text as verb, status::text as status, result"
                " from soc.command_intents where id = $1",
                intent,
            )
            if row is None:
                return
            loaded = await store.load(connection, row["operation_id"])
            if loaded is None:
                return
            outcome = lifecycle.Outcome(row["verb"], row["flight_id"], row["status"], row["result"])
            decision = lifecycle.on_outcome(loaded.snapshot, outcome)
            await store.apply(connection, loaded, decision.actions)

    async def _progress(self, flight: uuid.UUID) -> None:
        async with self.database.transaction() as connection:
            operation = await connection.fetchval(
                "select operation_id from soc.flights where id = $1", flight
            )
            loaded = None if operation is None else await store.load(connection, operation)
            if loaded is None:
                return
            decision = lifecycle.on_progress(loaded.snapshot, flight)
            await store.apply(connection, loaded, decision.actions)

    async def _judge_operation(self, operation: uuid.UUID) -> None:
        async with self.database.transaction() as connection:
            loaded = await store.load(connection, operation)
            if loaded is None:
                return
            if loaded.snapshot.state in WAITING:
                decision = lifecycle.on_tick(loaded.snapshot, self._clock())
                await store.apply(connection, loaded, decision.actions)
                return
            if loaded.snapshot.state not in JUDGED:
                return
            checks = self._judged(connection, loaded)
            await _record(connection, operation, checks)
            decision = lifecycle.on_checks(loaded.snapshot, checks)
            await store.apply(connection, loaded, decision.actions)

    def _judged(
        self, _connection: asyncpg.Connection, loaded: store.Loaded
    ) -> Sequence[lifecycle.Check]:
        return self._judge(loaded, self._tunables, self._clock())


async def _record(
    connection: asyncpg.Connection, operation: uuid.UUID, checks: Sequence[lifecycle.Check]
) -> None:
    """Write the checks that changed; the database broadcasts each (IR-CHK)."""
    if not checks:
        return
    rows = [
        {
            "check_id": check.check_id,
            "state": check.state,
            "blocking": check.blocking,
            "value": _finite(getattr(check, "value", None)),
            "detail": check.detail,
            "evaluated_at": datetime.now(UTC).isoformat(),
        }
        for check in checks
    ]
    await connection.execute("select soc.record_checks($1, $2::jsonb)", operation, json.dumps(rows))


def _finite(value: Any) -> Any:
    """The value with every number that is not finite as null: jsonb holds no NaN."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _finite(each) for key, each in value.items()}
    if isinstance(value, list | tuple):
        return [_finite(each) for each in value]
    return value
