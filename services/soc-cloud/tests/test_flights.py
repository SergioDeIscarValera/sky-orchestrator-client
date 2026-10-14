"""The flights soc-cloud watches, against fakes (FR-SAF-01, FR-SAF-06, FR-TEL-04, FR-LOG-02).

The database and the wire are in-memory fakes, so each rule is held without a container:
the file kept under the database's token, the first sample outside sending one return home
before any write, the warning band entered once, take-off, landing and the aircraft's own
return from its mode, one sample a second in the track, telemetry gone stale raising one
event and no command, the progress recorded with how it ended, and every record written in
order, once, through a database that goes away.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime
from typing import Any

import asyncpg
import pytest
from structlog.testing import capture_logs

from soc_cloud.commands import Intent
from soc_cloud.files import FlightFiles
from soc_cloud.flights import (
    HISTORY_SLOT_MS,
    TRACK,
    TRACK_COLUMNS,
    Flight,
    FlightWatch,
    TrackRow,
)
from soc_cloud.link.progress import BreakPoint, FlightProgress, FlightStatus
from soc_cloud.link.telemetry import Sample
from soc_db import DatabaseUnavailableError

DOCK = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV01"
FILES = "http://soc-cloud:8090"
TOKEN = "0f" * 16
KMZ = b"PK\x03\x04flight"
# A square of about 166 by 178 m round the farm, its ceiling 120 m (the harness's SQUARE).
SQUARE = [[-4.7255, 41.6515], [-4.7235, 41.6515], [-4.7235, 41.6531], [-4.7255, 41.6531]]
INSIDE = (41.6523, -4.7245)
IN_BAND = (41.6523, -4.72546)  # about 3.3 m inside the west edge
OUTSIDE = (41.6523, -4.7262)  # about 58 m west of it
STALE_AFTER_MS = 3000
BAND_M = 5.0
T0_MS = 1_791_000_000_000
NAMED = uuid.uuid4()


def flight(**changes: Any) -> Flight:
    made = Flight(
        id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
        operation_id=uuid.uuid4(),
        fleet_id=uuid.uuid4(),
        gateway=DOCK,
        aircraft=AIRCRAFT,
        geofence={"polygon": SQUARE, "max_height_m": 120},
    )
    return replace(made, **changes)


def sample(
    at_ms: int = T0_MS,
    where: tuple[float, float] | None = INSIDE,
    height_m: float | None = 30.0,
    mode: int | None = 5,
    aircraft: str = AIRCRAFT,
) -> Sample:
    return Sample(
        stack="lab",
        gateway=DOCK,
        aircraft=aircraft,
        taken_at_ms=at_ms,
        latitude_deg=None if where is None else where[0],
        longitude_deg=None if where is None else where[1],
        height_m=height_m,
        heading_deg=90.0,
        home_distance_m=12.0,
        battery_pct=81,
        satellites=19,
        gps_quality=5,
        mode_code=mode,
    )


def progress(
    flight_id: uuid.UUID, status: FlightStatus | None, result: int | None = 0, **more: Any
) -> FlightProgress:
    return FlightProgress(
        bid=str(flight_id),
        flight_id=str(flight_id),
        timestamp=T0_MS,
        gateway=DOCK,
        status=status,
        result=result,
        **more,
    )


def intent(verb: str, flight_id: uuid.UUID) -> Intent:
    return Intent(
        id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
        operation_id=uuid.uuid4(),
        flight_id=flight_id,
        gateway_sn=DOCK,
        verb=verb,
        payload={},
        status="accepted",
        requested_at=datetime.now().astimezone(),
        sent_at=None,
    )


class FakeStore:
    """soc.flights, soc.flight_files and soc-cloud's record functions, in memory."""

    def __init__(self) -> None:
        self.flights: dict[uuid.UUID, Flight] = {}
        self.files: dict[uuid.UUID, tuple[bytes, str]] = {}
        self.ended: set[uuid.UUID] = set()
        self.breached: set[uuid.UUID] = set()
        self.records: list[tuple[str, Any]] = []
        self.latest: list[tuple[str, dict[str, Any]]] = []
        self.track: list[TrackRow] = []
        self.track_inserts = 0
        # Raised by the next calls of each write, by its name, in turn.
        self.failures: dict[str, list[BaseException]] = {}
        self.reads_before: Callable[[], None] | None = None

    def add(self, made: Flight, file: tuple[bytes, str] | None = (KMZ, TOKEN)) -> Flight:
        self.flights[made.id] = made
        if file is not None:
            self.files[made.id] = file
        return made

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.records]

    def logged(self, kind: str) -> list[Any]:
        return [detail for each, detail in self.records if each == kind]

    def _fail(self, write: str) -> None:
        waiting = self.failures.get(write)
        if waiting:
            raise waiting.pop(0)

    async def unended(self) -> list[Flight]:
        found = [each for each in self.flights.values() if each.id not in self.ended]
        if self.reads_before is not None:
            self.reads_before()
        return found

    async def flight(self, flight_id: uuid.UUID) -> Flight | None:
        return self.flights.get(flight_id)

    async def file(self, flight_id: uuid.UUID) -> tuple[bytes, str] | None:
        return self.files.get(flight_id)

    async def record_latest(
        self, aircraft: str, gateway: str, sample: str, sampled_at: datetime
    ) -> None:
        self._fail("record_latest")
        self.latest.append((aircraft, json.loads(sample)))

    async def record_progress(
        self,
        flight_id: uuid.UUID,
        status: str,
        result: int | None,
        percent: int | None,
        waypoint: int | None,
        break_point: str | None,
        ended: str | None,
    ) -> None:
        self._fail("record_progress")
        point = None if break_point is None else json.loads(break_point)
        self.records.append(("progress", (status, result, percent, waypoint, point, ended)))

    async def record_moment(
        self, flight_id: uuid.UUID, moment: str, at: datetime, mode: int
    ) -> None:
        self._fail("record_moment")
        self.records.append((moment, mode))

    async def record_breach(
        self, flight_id: uuid.UUID, intent_id: uuid.UUID, outside: str, sampled_at: datetime
    ) -> bool:
        self._fail("record_breach")
        kept = flight_id not in self.breached
        self.breached.add(flight_id)
        self.records.append(("geofence_breach", (intent_id, json.loads(outside), sampled_at)))
        return kept

    async def log(
        self,
        operation: uuid.UUID,
        kind: str,
        payload: str,
        flight_id: uuid.UUID,
        fleet: uuid.UUID,
        at: datetime,
    ) -> None:
        self._fail("log")
        self.records.append((kind, json.loads(payload)))

    async def record_track(self, rows: Sequence[TrackRow]) -> None:
        self._fail("record_track")
        self.track_inserts += 1
        self.track.extend(rows)


class FakeReturner:
    """commands.Commands' send_now and recorded: what was sent and recorded."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, uuid.UUID, str, uuid.UUID]] = []
        self.recorded_intents: list[tuple[uuid.UUID, bool]] = []
        self.failures = 0
        self.gate: asyncio.Event | None = None
        self.attempts = 0

    async def send_now(self, gateway: str, flight_id: uuid.UUID, verb: str) -> uuid.UUID | None:
        self.attempts += 1
        if self.gate is not None:
            await self.gate.wait()
        if self.failures:
            self.failures -= 1
            return None
        sent = uuid.uuid4()
        self.sent.append((gateway, flight_id, verb, sent))
        return sent

    def recorded(self, intent_id: uuid.UUID, *, kept: bool) -> None:
        self.recorded_intents.append((intent_id, kept))


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Watch:
    def __init__(self) -> None:
        self.store = FakeStore()
        self.returner = FakeReturner()
        self.files = FlightFiles({"lab": FILES}, grace_s=0.0)
        self.monotonic = Clock()
        self.watch = FlightWatch(
            self.store,
            self.files,
            self.returner,
            stale_after_ms=STALE_AFTER_MS,
            warning_band_m=BAND_M,
            batch_s=3600,
            retry_s=0.001,
            reconcile_s=3600,
            stale_tick_s=3600,
            monotonic=self.monotonic,
        )

    async def executing(self, **changes: Any) -> Flight:
        """A flight watched from its prepare and executing from its execute accepted."""
        made = self.store.add(flight(**changes))
        assert await self.watch.preparing(intent("prepare", made.id))
        self.watch.settled(intent("execute", made.id), 0)
        return made

    async def settle(self) -> None:
        """Waits until every record so far is written and every send has returned."""
        await until(lambda: not self.watch._journal and not self.watch._tasks)


async def until(condition: Callable[[], bool], within_s: float = 2.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.001)


@asynccontextmanager
async def watching() -> AsyncIterator[Watch]:
    watch = Watch()
    task = asyncio.create_task(watch.watch.run())
    try:
        yield watch
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


# --- Its file and its watch --------------------------------------------------------------


async def test_a_prepare_keeps_the_flights_file_under_the_databases_token() -> None:
    async with watching() as cloud:
        made = cloud.store.add(flight())
        assert await cloud.watch.preparing(intent("prepare", made.id))
        offered = cloud.files.offer("lab", str(made.id))
        served = cloud.files.served(TOKEN)
    assert offered is not None
    assert offered.url == f"{FILES}/files/{TOKEN}.kmz"
    assert served is not None and served.content == KMZ
    watched = cloud.watch.watched(made.id)
    assert watched is not None and not watched.executing


@pytest.mark.parametrize(
    ("file", "named"),
    [
        (None, "flight_file_not_found"),
        ((KMZ, "not-a-token"), "flight_file_not_kept"),
    ],
)
async def test_a_prepare_whose_file_cannot_be_served_must_not_go_out(
    file: tuple[bytes, str] | None, named: str
) -> None:
    async with watching() as cloud:
        made = cloud.store.add(flight(), file=file)
        with capture_logs() as logs:
            assert not await cloud.watch.preparing(intent("prepare", made.id))
    assert [entry["event"] for entry in logs] == [named]
    assert cloud.watch.watched(made.id) is None


async def test_a_flight_executes_from_its_execute_accepted_never_a_refused_one() -> None:
    async with watching() as cloud:
        made = cloud.store.add(flight())
        await cloud.watch.preparing(intent("prepare", made.id))
        cloud.watch.settled(intent("execute", made.id), 314010)
        cloud.watch.settled(intent("pause", made.id), 0)
        watched = cloud.watch.watched(made.id)
        assert watched is not None and not watched.executing
        cloud.watch.settled(intent("execute", made.id), 0)
        assert watched.executing


@pytest.mark.parametrize("status", [FlightStatus.IN_PROGRESS, FlightStatus.PAUSED])
async def test_a_progress_in_flight_says_the_flight_executes(status: FlightStatus) -> None:
    async with watching() as cloud:
        made = cloud.store.add(flight())
        await cloud.watch.preparing(intent("prepare", made.id))
        cloud.watch.progressed(progress(made.id, status))
        watched = cloud.watch.watched(made.id)
        assert watched is not None and watched.executing


async def test_a_sweep_watches_the_flights_not_ended_and_ends_the_rest() -> None:
    async with watching() as cloud:
        kept = cloud.store.add(flight(executing=True, took_off=True))
        ended = cloud.store.add(flight(), file=(b"other", "1a" * 16))
        await cloud.watch.sweep()
        assert cloud.files.served("1a" * 16) is not None
        cloud.store.ended.add(ended.id)
        cloud.monotonic.now += 1
        await cloud.watch.sweep()
        assert cloud.watch.watched(ended.id) is None
        assert cloud.files.served("1a" * 16) is None
        watched = cloud.watch.watched(kept.id)
        assert watched is not None and watched.executing and watched.took_off
        assert cloud.files.served(TOKEN) is not None


async def test_a_flight_watched_while_a_sweep_reads_is_not_ended_by_it() -> None:
    async with watching() as cloud:
        late = flight()

        def prepared_meanwhile() -> None:
            # Committed with its prepare after the sweep's read began, so the read did not
            # see it, and heard while that read is on.
            cloud.store.add(late)
            cloud.monotonic.now += 1
            cloud.watch._watch(late)

        cloud.store.reads_before = prepared_meanwhile
        await cloud.watch.sweep()
        assert cloud.watch.watched(late.id) is not None


# --- The cloud geofence (FR-SAF-01) ------------------------------------------------------


async def test_the_first_sample_outside_returns_the_aircraft_once() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        cloud.watch.sampled(sample(T0_MS, INSIDE))
        cloud.watch.sampled(sample(T0_MS + 200, OUTSIDE))
        cloud.watch.sampled(sample(T0_MS + 400, OUTSIDE))
        await cloud.settle()
        cloud.watch.sampled(sample(T0_MS + 600, OUTSIDE))
        await cloud.settle()
    ((gateway, flight_id, verb, sent),) = cloud.returner.sent
    assert (gateway, flight_id, verb) == (DOCK, made.id, "return_home")
    ((recorded, outside, sampled_at),) = cloud.store.logged("geofence_breach")
    assert recorded == sent
    assert outside["position"] == [OUTSIDE[1], OUTSIDE[0]]
    assert outside["height_m"] == 30.0
    assert outside["distance_outside_m"] == pytest.approx(58.0, abs=1.0)
    assert round(sampled_at.timestamp() * 1000) == T0_MS + 200
    assert cloud.returner.recorded_intents == [(sent, True)]


async def test_a_sample_above_the_ceiling_is_a_breach() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.sampled(sample(T0_MS, INSIDE, height_m=120.5))
        await cloud.settle()
    assert len(cloud.returner.sent) == 1
    ((_, outside, _),) = cloud.store.logged("geofence_breach")
    assert outside["above_ceiling_m"] == pytest.approx(0.5)


async def test_the_return_goes_out_before_anything_is_written() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.store.failures = {"record_breach": [DatabaseUnavailableError("away")] * 3}
        cloud.watch.sampled(sample(T0_MS, OUTSIDE))
        await until(lambda: len(cloud.returner.sent) == 1)
        await cloud.settle()
    assert cloud.store.kinds()[-1] == "geofence_breach"


async def test_a_return_that_could_not_be_sent_is_tried_with_the_next_sample_outside() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.returner.failures = 1
        with capture_logs() as logs:
            cloud.watch.sampled(sample(T0_MS, OUTSIDE))
            await cloud.settle()
        assert cloud.returner.sent == []
        assert "geofence_return_not_sent" in [entry["event"] for entry in logs]
        cloud.watch.sampled(sample(T0_MS + 200, OUTSIDE))
        await cloud.settle()
    assert len(cloud.returner.sent) == 1
    assert len(cloud.store.logged("geofence_breach")) == 1


async def test_samples_outside_while_the_return_is_being_sent_send_it_once() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.returner.gate = asyncio.Event()
        for step in range(5):
            cloud.watch.sampled(sample(T0_MS + step * 200, OUTSIDE))
        await asyncio.sleep(0.01)
        cloud.returner.gate.set()
        await cloud.settle()
    assert cloud.returner.attempts == 1
    assert len(cloud.returner.sent) == 1


async def test_a_flight_breached_before_a_restart_is_never_returned_again() -> None:
    async with watching() as cloud:
        cloud.store.add(flight(executing=True, breached=True))
        await cloud.watch.sweep()
        cloud.watch.sampled(sample(T0_MS, OUTSIDE))
        await cloud.settle()
    assert cloud.returner.attempts == 0


async def test_a_breach_the_database_already_holds_is_not_settled_twice() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        cloud.store.breached.add(made.id)
        with capture_logs() as logs:
            cloud.watch.sampled(sample(T0_MS, OUTSIDE))
            await cloud.settle()
    ((_, _, _, sent),) = cloud.returner.sent
    assert cloud.returner.recorded_intents == [(sent, False)]
    assert "geofence_breach_not_recorded" in [entry["event"] for entry in logs]


async def test_a_breach_the_database_refuses_releases_its_reply() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.store.failures = {"record_breach": [asyncpg.CheckViolationError("refused")]}
        cloud.watch.sampled(sample(T0_MS, OUTSIDE))
        await cloud.settle()
    ((_, _, _, sent),) = cloud.returner.sent
    assert cloud.returner.recorded_intents == [(sent, False)]


async def test_only_an_executing_flight_is_judged() -> None:
    async with watching() as cloud:
        made = cloud.store.add(flight())
        await cloud.watch.preparing(intent("prepare", made.id))
        cloud.watch.sampled(sample(T0_MS, OUTSIDE, mode=0))
        await cloud.settle()
    assert cloud.returner.attempts == 0
    assert cloud.store.records == []


async def test_a_sample_without_a_position_is_not_judged_inside() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.sampled(sample(T0_MS, IN_BAND))
        cloud.watch.sampled(sample(T0_MS + 200, None))
        cloud.watch.sampled(sample(T0_MS + 400, IN_BAND))
        await cloud.settle()
    # Unknown is not inside: the band was never left, so it warned once.
    assert len(cloud.store.logged("geofence_warning")) == 1
    assert cloud.returner.attempts == 0


async def test_entering_the_warning_band_warns_once_each_time() -> None:
    async with watching() as cloud:
        await cloud.executing()
        for step, where in enumerate([INSIDE, IN_BAND, IN_BAND, INSIDE, IN_BAND]):
            cloud.watch.sampled(sample(T0_MS + step * 200, where))
        await cloud.settle()
    warnings = cloud.store.logged("geofence_warning")
    assert len(warnings) == 2
    assert warnings[0]["position"] == [IN_BAND[1], IN_BAND[0]]
    assert warnings[0]["distance_to_boundary_m"] == pytest.approx(3.3, abs=0.2)
    assert cloud.returner.attempts == 0


async def test_a_geofence_that_cannot_be_judged_is_logged_and_judges_nothing() -> None:
    async with watching() as cloud:
        with capture_logs() as logs:
            await cloud.executing(geofence={"polygon": [[0, 0]], "max_height_m": 120})
        cloud.watch.sampled(sample(T0_MS, OUTSIDE))
        await cloud.settle()
    assert "flight_geofence_unusable" in [entry["event"] for entry in logs]
    assert cloud.returner.attempts == 0


async def test_the_time_from_sample_to_return_is_measured() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.sampled(sample(T0_MS, OUTSIDE))
        await cloud.settle()
    assert cloud.watch._latencies.summary()["geofence_return_ms"]["count"] == 1


# --- Take-off, landing, the aircraft's own return (FR-LOG-02) ----------------------------


async def test_take_off_return_and_landing_are_read_from_the_mode() -> None:
    async with watching() as cloud:
        await cloud.executing()
        for step, mode in enumerate([0, 1, 2, 4, 5, 5, 9, 9, 10, 14, 0, 0]):
            cloud.watch.sampled(sample(T0_MS + step * 200, mode=mode))
        await cloud.settle()
    assert [kind for kind in cloud.store.kinds() if kind != "geofence_warning"] == [
        "took_off",
        "automatic_return",
        "landed",
    ]
    assert cloud.store.logged("took_off") == [4]
    assert cloud.store.logged("landed") == [0]


async def test_a_restart_in_the_air_logs_no_take_off_and_no_return_already_on() -> None:
    async with watching() as cloud:
        cloud.store.add(flight(executing=True, took_off=True))
        await cloud.watch.sweep()
        for step, mode in enumerate([9, 9, 0]):
            cloud.watch.sampled(sample(T0_MS + step * 200, mode=mode))
        await cloud.settle()
    assert cloud.store.kinds() == ["landed"]


async def test_a_mode_that_says_nothing_of_where_it_is_moves_nothing() -> None:
    async with watching() as cloud:
        await cloud.executing()
        for step, mode in enumerate([None, 13, 14]):
            cloud.watch.sampled(sample(T0_MS + step * 200, mode=mode))
        await cloud.settle()
    assert cloud.store.records == []


# --- The track (FR-TEL-04) ---------------------------------------------------------------


async def test_the_track_keeps_the_first_sample_of_each_second_in_one_insert() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        for step in range(15):
            cloud.watch.sampled(sample(T0_MS + step * 200))
        cloud.watch.sampled(sample(T0_MS + 3200, where=None))
        await cloud.watch.flush_track()
    assert cloud.store.track_inserts == 1
    offsets = [round(row.sampled_at.timestamp() * 1000) - T0_MS for row in cloud.store.track]
    assert offsets == [0, 1000, 2000]
    first = cloud.store.track[0]
    assert (first.flight_id, first.fleet_id) == (made.id, made.fleet_id)
    assert (first.longitude, first.latitude, first.height_m) == (INSIDE[1], INSIDE[0], 30.0)
    assert (first.battery_pct, first.mode_code) == (81, 5)


async def test_ten_minutes_at_5_hz_store_600_samples_at_most_one_insert_per_batch() -> None:
    """FR-TEL-04's acceptance, with the jitter of a real link."""
    jitter = random.Random(7)  # noqa: S311 - a repeatable jitter, not a secret
    async with watching() as cloud:
        await cloud.executing()
        batch_ms, flushed_at = 5000, T0_MS
        for step in range(5 * 600):
            at = T0_MS + step * 200 + jitter.randint(-40, 40)
            cloud.watch.sampled(sample(at))
            if at - flushed_at >= batch_ms:
                await cloud.watch.flush_track()
                flushed_at = at
        await cloud.watch.flush_track()
    assert abs(len(cloud.store.track) - 600) <= 1
    assert cloud.store.track_inserts <= 600 * 1000 // batch_ms + 1


async def test_a_track_batch_the_database_is_away_for_goes_with_the_next() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.sampled(sample(T0_MS))
        cloud.store.failures = {"record_track": [DatabaseUnavailableError("away")]}
        await cloud.watch.flush_track()
        cloud.watch.sampled(sample(T0_MS + HISTORY_SLOT_MS))
        await cloud.watch.flush_track()
    assert len(cloud.store.track) == 2
    assert cloud.store.track_inserts == 1


def test_the_track_insert_names_the_rows_columns_in_order() -> None:
    named = TRACK.split("(", 1)[1].split(")", 1)[0]
    assert [column.strip() for column in named.split(",")] == list(TRACK_COLUMNS)


# --- Telemetry gone stale (FR-SAF-06) ----------------------------------------------------


async def test_telemetry_gone_stale_in_flight_raises_one_event_and_no_command() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.sampled(sample(T0_MS))
        cloud.monotonic.now += STALE_AFTER_MS / 1000
        cloud.watch.check_staleness()
        assert cloud.store.logged("telemetry_stale") == []
        cloud.monotonic.now += 0.01
        for _ in range(3):
            cloud.watch.check_staleness()
        await cloud.settle()
        assert cloud.store.logged("telemetry_stale") == [
            {"last_sampled_at": "2026-10-03T04:00:00+00:00"}
        ]
        cloud.watch.sampled(sample(T0_MS + 4000))
        await cloud.settle()
    assert cloud.store.logged("telemetry_fresh") == [{"sampled_at": "2026-10-03T04:00:04+00:00"}]
    assert cloud.returner.attempts == 0


async def test_a_flight_executing_with_no_sample_yet_goes_stale_too() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.monotonic.now += STALE_AFTER_MS / 1000 + 0.01
        cloud.watch.check_staleness()
        await cloud.settle()
    assert cloud.store.logged("telemetry_stale") == [{"last_sampled_at": None}]


async def test_a_flight_on_the_ground_after_its_task_or_not_executing_never_goes_stale() -> None:
    async with watching() as cloud:
        cloud.store.add(flight(executing=True, took_off=True, landed=True, terminal=True))
        cloud.store.add(flight(executing=True, terminal=True))
        cloud.store.add(flight())
        await cloud.watch.sweep()
        cloud.monotonic.now += 60
        cloud.watch.check_staleness()
        await cloud.settle()
    assert cloud.store.records == []


# --- The task's progress (FR-LNK-07) -----------------------------------------------------


async def test_a_progress_is_recorded_with_how_its_task_ended() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        cloud.watch.progressed(
            progress(made.id, FlightStatus.IN_PROGRESS, percent=40, current_waypoint_index=3)
        )
        cloud.watch.progressed(
            progress(
                made.id,
                FlightStatus.CANCELED,
                result=0,
                break_point=BreakPoint(index=3, break_reason=773),
            )
        )
        cloud.watch.progressed(progress(made.id, FlightStatus.FAILED, result=322283))
        await cloud.settle()
    assert cloud.store.logged("progress") == [
        ("in_progress", 0, 40, 3, None, None),
        (
            "canceled",
            0,
            None,
            None,
            {
                "index": 3,
                "state": None,
                "progress": None,
                "wayline_id": None,
                "break_reason": 773,
                "attitude_head": None,
            },
            "low_battery",
        ),
        ("failed", 322283, None, None, None, "operator_return"),
    ]
    watched = cloud.watch.watched(made.id)
    assert watched is not None and watched.terminal


@pytest.mark.parametrize(
    "unusable",
    [
        FlightProgress(bid="not-a-flight", flight_id="not-a-flight", status=FlightStatus.OK),
        FlightProgress(bid=str(NAMED), flight_id=str(NAMED), status=None),
    ],
)
async def test_a_progress_naming_no_flight_or_no_status_is_not_recorded(
    unusable: FlightProgress,
) -> None:
    async with watching() as cloud:
        with capture_logs() as logs:
            cloud.watch.progressed(unusable)
        await cloud.settle()
    assert cloud.store.records == []
    assert [entry["event"] for entry in logs] == ["flight_progress_unusable"]


# --- The fleet's presence (FR-LOG-02) ----------------------------------------------------


async def test_the_aircraft_going_offline_and_online_is_logged_for_its_flights() -> None:
    async with watching() as cloud:
        await cloud.executing()
        cloud.watch.presence(AIRCRAFT, online=False)
        cloud.watch.presence("SOMEOTHERUAV", online=False)
        cloud.watch.presence(AIRCRAFT, online=True)
        await cloud.settle()
    assert cloud.store.records == [
        ("fleet_offline", {"aircraft_sn": AIRCRAFT}),
        ("fleet_online", {"aircraft_sn": AIRCRAFT}),
    ]


# --- The latest sample, and writing ------------------------------------------------------


async def test_every_aircrafts_latest_sample_is_recorded_as_broadcast() -> None:
    async with watching() as cloud:
        cloud.watch.sampled(sample(T0_MS, aircraft="SOUAVONE"))
        await until(lambda: len(cloud.store.latest) == 1)
    ((aircraft, written),) = cloud.store.latest
    assert aircraft == "SOUAVONE"
    assert written["taken_at_ms"] == T0_MS
    assert written["battery_pct"] == 81
    assert written["latitude_deg"] == INSIDE[0]


async def test_the_latest_sample_kept_while_the_database_is_away_is_the_newest() -> None:
    async with watching() as cloud:
        cloud.store.failures = {"record_latest": [DatabaseUnavailableError("away")]}
        cloud.watch.sampled(sample(T0_MS))
        cloud.watch.sampled(sample(T0_MS + 200))
        await until(lambda: len(cloud.store.latest) == 1)
        await asyncio.sleep(0.02)
    assert [written["taken_at_ms"] for _, written in cloud.store.latest] == [T0_MS + 200]


async def test_records_are_written_in_order_once_through_a_database_that_goes_away() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        cloud.store.failures = {
            "record_progress": [DatabaseUnavailableError("away")],
            "record_moment": [asyncpg.LockNotAvailableError("busy")],
        }
        cloud.watch.progressed(progress(made.id, FlightStatus.IN_PROGRESS))
        for step, mode in enumerate([0, 5]):
            cloud.watch.sampled(sample(T0_MS + step * 200, mode=mode))
        cloud.watch.presence(AIRCRAFT, online=False)
        await cloud.settle()
    assert cloud.store.kinds() == ["progress", "took_off", "fleet_offline"]


async def test_a_record_the_database_refuses_is_logged_and_the_next_is_written() -> None:
    async with watching() as cloud:
        made = await cloud.executing()
        cloud.store.failures = {"record_progress": [asyncpg.CheckViolationError("refused")]}
        with capture_logs() as logs:
            cloud.watch.progressed(progress(made.id, FlightStatus.IN_PROGRESS))
            cloud.watch.presence(AIRCRAFT, online=False)
            await cloud.settle()
    assert cloud.store.kinds() == ["fleet_offline"]
    refused = [entry for entry in logs if entry["event"] == "flight_record_refused"]
    assert [entry["record"] for entry in refused] == ["flight_progress"]
