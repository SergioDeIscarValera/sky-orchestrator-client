"""Dry runs of flight files, against fakes (FR-LNK-09, IR-DRY).

The stack's validation API and soc.dry_runs are in-memory fakes: a run is judged valid,
rejected or failed by the verdict or the error the stack gave, a run for a stack this service
does not serve fails with that reason, the sweep finds what is pending, a run announced twice
is judged once, and a verdict the database is away for is recorded when it is back.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import asyncpg
import msgspec
import pytest
from structlog.testing import capture_logs

from soc_cloud.dry_runs import DryRuns, Outcome, Request
from soc_cloud.so_api import SoApiError, Validation
from soc_db import DatabaseUnavailableError

KMZ = b"PK\x03\x04" + bytes(range(64))
FARM = (41.6523, -4.7245)
SHA_CONFIG = "a" * 64
MD5 = "0" * 32

VALID_WIRE: dict[str, Any] = {
    "status": "VALID",
    "fingerprint_md5": MD5,
    "size_bytes": len(KMZ),
    "config_fingerprint": SHA_CONFIG,
    "metadata": {"name": "reference", "waypoint_count": 12, "total_distance_m": 5400.0},
    "report": {
        "status": "VALID",
        "checks": [{"check": "archive", "status": "passed", "detail": "a zip with 4 entries"}],
        "problems": [],
    },
}
REJECTED_WIRE: dict[str, Any] = {
    "status": "REJECTED",
    "fingerprint_md5": MD5,
    "size_bytes": len(KMZ),
    "config_fingerprint": SHA_CONFIG,
    "metadata": {"name": "reference", "waypoint_count": 12, "total_distance_m": 5400.0},
    "report": {
        "status": "REJECTED",
        "checks": [
            {"check": "archive", "status": "passed", "detail": "a zip with 4 entries"},
            {"check": "geofence", "status": "failed", "detail": "1 waypoint outside"},
        ],
        "problems": [
            {
                "code": "outside_geofence",
                "kind": "envelope",
                "message": "waypoint 3 is 3412 m from the centre, the limit is 3000 m",
                "waypoint_index": 3,
                "details": {"distance_m": 3412.0, "limit_m": 3000.0},
            },
            {
                "code": "speed_above_max",
                "kind": "envelope",
                "message": "waypoint 5 flies at 18 m/s, the limit is 15 m/s",
                "waypoint_index": 5,
            },
        ],
    },
}


def decoded[T](kind: type[T], wire: dict[str, Any]) -> T:
    return msgspec.json.decode(msgspec.json.encode(wire), type=kind)


class FakeJudge:
    """A stack's validation API: it answers the verdict a test sets, fails the next call it is
    given, takes as long as a test says, and records what it was asked."""

    def __init__(self) -> None:
        self.verdict = decoded(Validation, REJECTED_WIRE)
        self.failures: list[SoApiError] = []
        self.delay_s = 0.0
        self.asked: list[tuple[bytes, tuple[float, float] | None]] = []

    async def validate(self, kmz: bytes, *, takeoff: tuple[float, float] | None) -> Validation:
        self.asked.append((kmz, takeoff))
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        if self.failures:
            raise self.failures.pop(0)
        return self.verdict


@dataclass
class Row:
    stack: str
    kmz: bytes
    takeoff: tuple[float, float]
    status: str = "pending"
    verdict: str | None = None


class FakeDryRunStore:
    """soc.dry_runs and soc.record_dry_run: a run is judged once, while it is pending."""

    def __init__(self) -> None:
        self.rows: dict[uuid.UUID, Row] = {}
        self.failures: dict[str, list[BaseException]] = {}

    def request(
        self,
        *,
        stack: str = "lab",
        status: str = "pending",
        kmz: bytes = KMZ,
        takeoff: tuple[float, float] = FARM,
    ) -> uuid.UUID:
        run = uuid.uuid4()
        self.rows[run] = Row(stack, kmz, takeoff, status)
        return run

    def _fail_if_asked(self, method: str) -> None:
        if self.failures.get(method):
            raise self.failures[method].pop(0)

    async def pending(self) -> list[uuid.UUID]:
        self._fail_if_asked("pending")
        return [run for run, row in self.rows.items() if row.status == "pending"]

    async def get(self, run: uuid.UUID) -> Request | None:
        self._fail_if_asked("get")
        row = self.rows.get(run)
        if row is None or row.status != "pending":
            return None
        return Request(stack=row.stack, kmz=row.kmz, takeoff=row.takeoff)

    async def judge(self, run: uuid.UUID, outcome: Outcome, verdict: str) -> None:
        self._fail_if_asked("judge")
        row = self.rows[run]
        if row.status != "pending":
            return
        row.status = outcome
        row.verdict = verdict


def verdict_of(store: FakeDryRunStore, run: uuid.UUID) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(store.rows[run].verdict or "{}")
    return loaded


def without_nulls(value: Any) -> Any:
    """The stored verdict without the nulls the struct writes for the fields SO left out: each
    of them is None in the contract whether SO sent null or nothing (FR-LNK-09)."""
    if isinstance(value, dict):
        return {key: without_nulls(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [without_nulls(item) for item in value]
    return value


async def until(condition: Callable[[], bool], within_s: float = 1.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.002)


def judged(store: FakeDryRunStore, runs: Iterable[uuid.UUID]) -> Callable[[], bool]:
    return lambda: all(store.rows[run].status != "pending" for run in runs)


@asynccontextmanager
async def judging(store: FakeDryRunStore, apis: dict[str, FakeJudge]) -> AsyncIterator[DryRuns]:
    dry_runs = DryRuns(store, retry_s=0.001)
    task = asyncio.create_task(dry_runs.run(apis))
    try:
        yield dry_runs
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_a_valid_verdict_is_recorded_valid_with_so_s_report() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    judge.verdict = decoded(Validation, VALID_WIRE)
    run = store.request()
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert store.rows[run].status == "valid"
    assert without_nulls(verdict_of(store, run)) == VALID_WIRE


async def test_a_rejected_verdict_is_recorded_rejected_with_every_problem_so_named() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    run = store.request()
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert store.rows[run].status == "rejected"
    assert without_nulls(verdict_of(store, run)) == REJECTED_WIRE
    problems = verdict_of(store, run)["report"]["problems"]
    assert [problem["waypoint_index"] for problem in problems] == [3, 5]


async def test_an_error_from_the_stack_fails_the_run_with_what_went_wrong() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    judge.failures = [SoApiError("POST /v1/validations answered 500: boom", status=500)]
    run = store.request()
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert store.rows[run].status == "failed"
    assert verdict_of(store, run) == {"error": "POST /v1/validations answered 500: boom"}


async def test_a_run_for_a_stack_soc_cloud_does_not_serve_fails_with_that_reason() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    run = store.request(stack="elsewhere")
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert store.rows[run].status == "failed"
    assert verdict_of(store, run)["error"] == "stack elsewhere is not served by this soc-cloud"
    assert judge.asked == []


async def test_the_file_and_its_takeoff_reach_the_stack_as_its_api_takes_them() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    run = store.request(kmz=b"PK\x03\x04the file", takeoff=(41.6523, -4.7245))
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert judge.asked == [(b"PK\x03\x04the file", (41.6523, -4.7245))]


async def test_the_sweep_judges_the_pending_runs_and_leaves_the_judged_ones() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    first, second = store.request(), store.request()
    earlier = store.request(status="valid")
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.sweep()
        await until(judged(store, [first, second]))
    assert len(judge.asked) == 2
    assert store.rows[earlier].status == "valid"


async def test_a_run_announced_twice_is_judged_once() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    judge.delay_s = 0.02
    run = store.request()
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
        await asyncio.sleep(0.05)
        await dry_runs.announced(str(run))
        await asyncio.sleep(0.02)
    assert len(judge.asked) == 1


async def test_an_announcement_that_is_not_a_run_is_ignored() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    with capture_logs() as logs:
        async with judging(store, {"lab": judge}) as dry_runs:
            await dry_runs.announced("not-a-uuid")
            await asyncio.sleep(0.01)
    assert judge.asked == []
    assert any(line["event"] == "dry_run_announcement_unreadable" for line in logs)


async def test_a_sweep_the_database_is_away_for_is_missed_and_found_by_the_next() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    run = store.request()
    store.failures = {"pending": [DatabaseUnavailableError("away")]}
    async with judging(store, {"lab": judge}) as dry_runs:
        with capture_logs() as logs:
            await dry_runs.sweep()
        assert any(line["event"] == "dry_runs_sweep_missed" for line in logs)
        assert judge.asked == []
        await dry_runs.sweep()
        await until(judged(store, [run]))
    assert store.rows[run].status == "rejected"


async def test_a_verdict_the_database_is_away_for_is_recorded_when_it_is_back() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    judge.verdict = decoded(Validation, VALID_WIRE)
    run = store.request()
    store.failures = {"judge": [DatabaseUnavailableError("away")] * 2}
    async with judging(store, {"lab": judge}) as dry_runs:
        await dry_runs.announced(str(run))
        await until(judged(store, [run]))
    assert store.rows[run].status == "valid"
    assert len(judge.asked) == 1


async def test_a_verdict_the_database_refuses_is_logged_and_the_run_stays_pending() -> None:
    store, judge = FakeDryRunStore(), FakeJudge()
    run = store.request()
    store.failures = {"judge": [asyncpg.CheckViolationError("verdict refused")]}
    with capture_logs() as logs:
        async with judging(store, {"lab": judge}) as dry_runs:
            await dry_runs.announced(str(run))
            await until(lambda: any(line["event"] == "dry_run_refused" for line in logs))
    assert store.rows[run].status == "pending"
