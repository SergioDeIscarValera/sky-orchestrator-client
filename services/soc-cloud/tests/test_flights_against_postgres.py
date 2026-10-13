"""The flights' store in Postgres, as soc-cloud's role, with SOC's migrations (ADR-0025).

What the gate's fake stands in for, held against the real functions and policies: the flights
not ended read with what soc-cloud has seen of them, a file's bytes and token, the track
written in one insert that a sample written twice does not refuse, the latest sample kept,
and a closed operation's log left alone without an error.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from soc_cloud.flights import PostgresFlightStore, TrackRow
from soc_database.harness import Flown, Operations, Tenancy
from soc_database.realtime import RealtimeStack
from soc_db import Database, Target

pytestmark = pytest.mark.lane

AT = datetime(2026, 10, 13, 10, 0, 0, tzinfo=UTC)
TO_COMPLETED = (
    "planned",
    "preparing",
    "simulating",
    "simulated",
    "ready",
    "launching",
    "in_flight",
    "returning",
    "completed",
)


async def until(condition: Callable[[], bool], within_s: float = 10.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.01)


@asynccontextmanager
async def store_and_admin(
    platform: RealtimeStack, passwords: dict[str, str]
) -> AsyncIterator[tuple[PostgresFlightStore, asyncpg.Connection, Flown]]:
    admin = await platform.postgres.connect("supabase_admin")
    database = Database(
        Target(
            host="127.0.0.1",
            port=platform.postgres.port,
            database="postgres",
            role="soc_cloud",
            password=passwords["soc_cloud"],
            application_name="soc-cloud-flights-test",
        )
    )
    task = asyncio.create_task(database.run())
    try:
        await until(lambda: database.health.up)
        flown = await Operations(admin).flown((await Tenancy(admin).member()).organization_id)
        yield PostgresFlightStore(database), admin, flown
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await admin.close()


def row(flown: Flown, at: datetime, height_m: float = 30.0) -> TrackRow:
    return TrackRow(
        flight_id=flown.flight_id,
        sampled_at=at,
        organization_id=flown.organization_id,
        fleet_id=flown.fleet_id,
        received_at=at + timedelta(milliseconds=40),
        longitude=-4.7245,
        latitude=41.6523,
        height_m=height_m,
        heading_deg=None,
        battery_pct=80,
        satellites=None,
        gps_quality=5,
        mode_code=5,
        home_distance_m=None,
    )


async def test_the_flights_not_ended_are_read_with_what_soc_cloud_has_seen(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, admin, flown):
        found = await store.flight(flown.flight_id)
        assert found is not None
        assert (found.gateway, found.aircraft, found.fleet_id) == (
            flown.gateway_sn,
            flown.aircraft_sn,
            flown.fleet_id,
        )
        assert found.geofence["max_height_m"] == 120
        assert not (found.executing or found.took_off or found.breached or found.terminal)
        await store.record_progress(flown.flight_id, "in_progress", 0, 10, 1, None, None)
        await store.record_moment(flown.flight_id, "took_off", AT, 4)
        seen = await store.flight(flown.flight_id)
        assert seen is not None and seen.executing and seen.took_off and not seen.landed
        assert flown.flight_id in {each.id for each in await store.unended()}
        await store.record_progress(flown.flight_id, "ok", 0, 100, 1, None, "completed")
        ended = await store.flight(flown.flight_id)
        assert ended is not None and ended.terminal
        await admin.execute(
            "update soc.flights set ended_at = now(), end_reason = 'completed' where id = $1",
            flown.flight_id,
        )
        assert flown.flight_id not in {each.id for each in await store.unended()}


async def test_a_flights_file_is_read_with_its_token(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, admin, flown):
        file = await store.file(flown.flight_id)
        token = await admin.fetchval(
            "select token from soc.flight_files where id = $1", flown.file_id
        )
    assert file == (b"PK\x03\x04kmz", token)


async def test_the_track_is_one_insert_and_a_sample_written_twice_is_not_refused(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, admin, flown):
        rows = [row(flown, AT + timedelta(seconds=second)) for second in range(3)]
        await store.record_track(rows)
        # Redelivered by the broker's persistent session after a reconnection.
        await store.record_track([rows[2], row(flown, AT + timedelta(seconds=3))])
        stored = await admin.fetch(
            "select sampled_at, height_m, satellites from soc.telemetry_samples"
            " where flight_id = $1 order by sampled_at",
            flown.flight_id,
        )
    assert [each["sampled_at"] for each in stored] == [
        AT + timedelta(seconds=second) for second in range(4)
    ]
    assert stored[0]["satellites"] is None


async def test_the_latest_sample_of_an_aircraft_is_kept_and_announced(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, admin, flown):
        heard: list[str] = []
        await admin.add_listener(
            "soc_aircraft_samples", lambda _c, _p, _ch, payload: heard.append(payload)
        )
        sample = {"aircraft_sn": flown.aircraft_sn, "battery_pct": 80}
        await store.record_latest(flown.aircraft_sn, flown.gateway_sn, json.dumps(sample), AT)
        await until(lambda: flown.aircraft_sn in heard)
        kept = await admin.fetchrow(
            "select sample, sampled_at, received_at from soc.aircraft_samples"
            " where aircraft_sn = $1",
            flown.aircraft_sn,
        )
    assert kept is not None
    assert json.loads(kept["sample"]) == sample
    assert kept["sampled_at"] == AT
    assert kept["received_at"] is not None


async def test_soc_clouds_entries_reach_an_open_log_and_never_a_closed_one(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, admin, flown):
        payload = json.dumps({"last_sampled_at": None})
        await store.log(
            flown.operation_id, "telemetry_stale", payload, flown.flight_id, flown.fleet_id, AT
        )
        await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
        await store.log(
            flown.operation_id, "telemetry_stale", payload, flown.flight_id, flown.fleet_id, AT
        )
        logged = await admin.fetch(
            "select severity::text as severity, source::text as source, occurred_at"
            " from soc.operation_events where flight_id = $1 and kind = 'telemetry_stale'",
            flown.flight_id,
        )
    assert [(each["severity"], each["source"], each["occurred_at"]) for each in logged] == [
        ("safety", "soc-cloud", AT)
    ]


async def test_a_breach_is_recorded_once_and_tells_soc_cloud_so(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    async with store_and_admin(platform, passwords) as (store, _admin, flown):
        outside = json.dumps(
            {"position": [-4.7262, 41.6523], "height_m": 30.0, "distance_outside_m": 58.1}
        )
        first = await store.record_breach(flown.flight_id, uuid.uuid4(), outside, AT)
        second = await store.record_breach(flown.flight_id, uuid.uuid4(), outside, AT)
        again = await store.flight(flown.flight_id)
    assert (first, second) == (True, False)
    assert again is not None and again.breached
