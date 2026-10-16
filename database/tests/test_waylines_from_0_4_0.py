from __future__ import annotations

import json
import uuid
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import asyncpg
import pytest

from soc_database import harness
from soc_database.harness import EphemeralPostgres, Tenancy
from soc_migrate.migrations import Migration, discover
from soc_migrate.roles import ServiceCredential
from soc_migrate.runner import Runner

# 0008 is the last migration a v0.4.0 database holds; 0009 converts what it saved.
LAST_RELEASED_VERSION = 8
OPERATION_KEYS = ("speed_ms", "takeoff_security_height_m", "finish_action")
# The conftest's todays_partition: the conversion broadcasts through realtime.send.
PARTITION = (
    "create table if not exists realtime.messages_soc_tests "
    "partition of realtime.messages "
    "for values from (now() - interval '2 days') to (now() + interval '2 days')"
)
TAKEOFF = [-4.7245, 41.6523]
PRIMITIVES = [
    {
        "kind": "route",
        "points": [
            {"position": [-4.7245, 41.65255]},
            {"position": [-4.72405, 41.65255]},
            {"position": [-4.72405, 41.6523], "height_m": 35},
        ],
    },
]
# A 1.0.0 design as 0.4.0 saved it: the shape of contracts/geometry/examples/.
LEGACY_DESIGN = {
    "schema_version": "1.0.0",
    "takeoff": TAKEOFF,
    "default_height_m": 30,
    "takeoff_security_height_m": 20,
    "speed_ms": 5,
    "finish_action": "return_home",
    "primitives": PRIMITIVES,
}
CURRENT_DESIGN = {
    "schema_version": "2.0.0",
    "takeoff": TAKEOFF,
    "default_height_m": 30,
    "primitives": PRIMITIVES,
}
WAYPOINTS = [
    {"index": 0, "position": [-4.7245, 41.65255], "height_m": 30},
    {"index": 1, "position": [-4.72405, 41.65255], "height_m": 30},
    {"index": 2, "position": [-4.72405, 41.6523], "height_m": 35},
    {"index": 3, "position": [-4.7243, 41.6523], "height_m": 30},
]
# 0008 requires duration_s at insert, so every seeded row carries it.
METRICS = {"waypoint_count": 4, "distance_m": 113.756227, "duration_s": 22.751}


@dataclass(frozen=True)
class Conversion:
    """The seeded waylines read before and after migration 0009, and what it did to them."""

    before: dict[str, dict[str, Any]]
    after: dict[str, dict[str, Any]]
    broadcasts_before: Counter[str]
    broadcasts_after: Counter[str]
    speed_columns_before: int
    speed_columns_after: int


@pytest.fixture(scope="module")
def legacy() -> Iterator[EphemeralPostgres]:
    database = EphemeralPostgres()
    database.start()
    try:
        yield database
    finally:
        database.stop()


async def migrate_with(
    database: EphemeralPostgres, migrations: list[Migration], credentials: list[ServiceCredential]
) -> None:
    connection = await database.connect()
    try:
        await Runner(connection).run(migrations, credentials)
    finally:
        await connection.close()


async def insert_wayline(
    admin: asyncpg.Connection,
    organization_id: uuid.UUID,
    name: str,
    design: dict[str, Any],
    bake_version: str,
) -> uuid.UUID:
    row_id = await admin.fetchval(
        "insert into soc.waylines (organization_id, name, takeoff, default_height_m, speed_ms,"
        " design, waypoints, metrics, bake_version)"
        " values ($1, $2, $3, 30, 5, $4, $5, $6, $7) returning id",
        organization_id,
        name,
        json.dumps(TAKEOFF),
        json.dumps(design),
        json.dumps(WAYPOINTS),
        json.dumps(METRICS),
        bake_version,
    )
    assert isinstance(row_id, uuid.UUID)
    return row_id


async def seed(admin: asyncpg.Connection, organization_id: uuid.UUID) -> dict[str, uuid.UUID]:
    """A live 0.4.0 wayline, a retired one, and one already at 2.0.0, which 0.4.0 never wrote."""
    live = await insert_wayline(admin, organization_id, "Pasillo 1", LEGACY_DESIGN, "1")
    retired = await insert_wayline(admin, organization_id, "Pasillo retirado", LEGACY_DESIGN, "1")
    await admin.execute("update soc.waylines set deleted_at = now() where id = $1", retired)
    current = await insert_wayline(admin, organization_id, "Pasillo 2.0", CURRENT_DESIGN, "2")
    return {"live": live, "retired": retired, "current": current}


async def read_row(admin: asyncpg.Connection, row_id: uuid.UUID) -> dict[str, Any]:
    row = await admin.fetchrow("select * from soc.waylines where id = $1", row_id)
    assert row is not None
    return dict(row)


async def count_broadcasts(
    admin: asyncpg.Connection, organization_id: uuid.UUID, ids: dict[str, uuid.UUID]
) -> Counter[str]:
    """The wayline messages on the organization's state topic, counted per row."""
    messages = await admin.fetch(
        "select payload from realtime.messages where topic = $1 and event = 'wayline'",
        f"org:{organization_id}:soc:state",
    )
    per_row = Counter(json.loads(message["payload"])["id"] for message in messages)
    return Counter({name: per_row[str(row_id)] for name, row_id in ids.items()})


async def count_speed_columns(admin: asyncpg.Connection) -> int:
    count = await admin.fetchval(
        "select count(*) from information_schema.columns"
        " where table_schema = 'soc' and table_name = 'waylines' and column_name = 'speed_ms'"
    )
    assert isinstance(count, int)
    return count


@pytest.fixture(scope="module")
async def conversion(legacy: EphemeralPostgres) -> Conversion:
    """Migrates to 0008, seeds three waylines, runs the rest, and reads them again."""
    passwords = harness.service_passwords()
    credentials = [ServiceCredential(role, password) for role, password in passwords.items()]
    migrations = discover(harness.MIGRATIONS)
    released = [migration for migration in migrations if migration.version <= LAST_RELEASED_VERSION]
    await migrate_with(legacy, released, credentials)
    admin = await legacy.connect("supabase_admin")
    try:
        await admin.execute(PARTITION)
        owner = await Tenancy(admin).member("owner")
        ids = await seed(admin, owner.organization_id)
        before = {name: await read_row(admin, row_id) for name, row_id in ids.items()}
        broadcasts_before = await count_broadcasts(admin, owner.organization_id, ids)
        speed_columns_before = await count_speed_columns(admin)
        await migrate_with(legacy, migrations, credentials)
        after = {name: await read_row(admin, row_id) for name, row_id in ids.items()}
        broadcasts_after = await count_broadcasts(admin, owner.organization_id, ids)
        speed_columns_after = await count_speed_columns(admin)
    finally:
        await admin.close()
    return Conversion(
        before=before,
        after=after,
        broadcasts_before=broadcasts_before,
        broadcasts_after=broadcasts_after,
        speed_columns_before=speed_columns_before,
        speed_columns_after=speed_columns_after,
    )


async def test_a_live_wayline_from_0_4_0_loses_the_keys_the_operation_owns(
    conversion: Conversion,
) -> None:
    original = json.loads(conversion.before["live"]["design"])
    assert set(OPERATION_KEYS) <= set(original)
    expected = {key: value for key, value in original.items() if key not in OPERATION_KEYS}
    expected["schema_version"] = "2.0.0"
    assert json.loads(conversion.after["live"]["design"]) == expected


async def test_a_live_wayline_from_0_4_0_loses_its_duration(conversion: Conversion) -> None:
    original = json.loads(conversion.before["live"]["metrics"])
    assert "duration_s" in original
    expected = {key: value for key, value in original.items() if key != "duration_s"}
    assert json.loads(conversion.after["live"]["metrics"]) == expected


async def test_a_live_wayline_from_0_4_0_keeps_its_geometry_and_its_bake(
    conversion: Conversion,
) -> None:
    before, after = conversion.before["live"], conversion.after["live"]
    for column in ("takeoff", "default_height_m", "waypoints", "bake_version"):
        assert after[column] == before[column], column


async def test_a_retired_wayline_from_0_4_0_is_not_touched(conversion: Conversion) -> None:
    """Its design and metrics are the same jsonb text as before, and no write reached it."""
    before, after = conversion.before["retired"], conversion.after["retired"]
    for column in ("design", "metrics", "updated_at", "deleted_at"):
        assert after[column] == before[column], column


async def test_a_wayline_already_at_2_0_0_is_not_touched(conversion: Conversion) -> None:
    """The schema filter must leave it alone, its duration_s included."""
    before, after = conversion.before["current"], conversion.after["current"]
    for column in ("design", "metrics", "waypoints", "updated_at"):
        assert after[column] == before[column], column


async def test_the_speed_column_is_gone_after_the_conversion(conversion: Conversion) -> None:
    assert conversion.speed_columns_before == 1
    assert conversion.speed_columns_after == 0


async def test_the_conversion_broadcasts_only_the_live_wayline(conversion: Conversion) -> None:
    grown = {
        name: conversion.broadcasts_after[name] - conversion.broadcasts_before[name]
        for name in ("live", "retired", "current")
    }
    assert grown == {"live": 1, "retired": 0, "current": 0}
