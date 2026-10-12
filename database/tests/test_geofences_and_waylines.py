from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as, impersonate

# Positions are [longitude, latitude], GeoJSON order (the canonical units table).
RING = [[-4.7260, 41.6520], [-4.7200, 41.6520], [-4.7200, 41.6480], [-4.7260, 41.6480]]
TAKEOFF = [-4.7241, 41.6500]
WAYPOINTS = [
    {"position": [-4.7241, 41.6500], "height_m": 30, "actions": []},
    {"position": [-4.7230, 41.6510], "height_m": 35, "actions": []},
]
DESIGN = {"primitives": [{"kind": "route", "points": [TAKEOFF, [-4.7230, 41.6510]]}]}
METRICS = {"waypoint_count": 2, "distance_m": 142.5}
DRAWN = {"name": "Norte", "polygon": RING, "max_height_m": 120, "origin": "drawn", "margin_m": None}
SAVED = {
    "name": "Pasillo 1",
    "takeoff": TAKEOFF,
    "default_height_m": 30,
    "design": DESIGN,
    "waypoints": WAYPOINTS,
    "metrics": METRICS,
    "bake_version": "1",
}
FIELDS = {"geofences": DRAWN, "waylines": SAVED}
JSON_COLUMNS = frozenset({"polygon", "takeoff", "design", "waypoints", "metrics"})
GEOFENCE_KEYS = frozenset({"id", "name", "origin", "updated_at", "deleted_at"})
WAYLINE_KEYS = frozenset({"id", "name", "updated_at", "deleted_at"})

GEOFENCE_REFUSALS = [
    pytest.param({"name": " "}, "geofence_name_given", id="blank-name"),
    pytest.param({"polygon": RING[:2]}, "geofence_polygon_ring", id="two-vertices"),
    pytest.param({"polygon": [*RING, RING[0]]}, "geofence_polygon_ring", id="closed-ring"),
    pytest.param(
        {"polygon": [*RING[:2], [-4.72, 41.65, 0]]}, "geofence_polygon_ring", id="vertex-of-three"
    ),
    pytest.param(
        {"polygon": [*RING[:2], ["-4.72", 41.65]]}, "geofence_polygon_ring", id="vertex-as-text"
    ),
    pytest.param(
        {"polygon": [*RING[:2], [-4.72, 91]]}, "geofence_polygon_ring", id="latitude-out-of-range"
    ),
    pytest.param(
        {"polygon": [*RING[:2], [-181, 41.65]]},
        "geofence_polygon_ring",
        id="longitude-out-of-range",
    ),
    pytest.param(
        {"polygon": [*RING[:2], [41.65, 181]]},
        "geofence_polygon_ring",
        id="latitude-written-first-out-of-range",
    ),
    pytest.param({"max_height_m": 0}, "geofence_max_height_positive", id="zero-height"),
    pytest.param(
        {"origin": "generated", "margin_m": None},
        "geofence_margin_when_generated",
        id="generated-without-margin",
    ),
    pytest.param(
        {"origin": "drawn", "margin_m": 10},
        "geofence_margin_when_generated",
        id="drawn-with-margin",
    ),
    pytest.param(
        {"origin": "generated", "margin_m": 4},
        "geofence_margin_when_generated",
        id="margin-of-four",
    ),
    pytest.param(
        {"origin": "generated", "margin_m": 101},
        "geofence_margin_when_generated",
        id="margin-of-one-hundred-and-one",
    ),
]

WAYLINE_REFUSALS = [
    pytest.param({"name": " "}, "wayline_name_given", id="blank-name"),
    pytest.param({"takeoff": [-4.72, 41.65, 0]}, "wayline_takeoff_position", id="takeoff-of-three"),
    pytest.param(
        {"default_height_m": 0}, "wayline_default_height_positive", id="zero-default-height"
    ),
    pytest.param({"design": [1, 2]}, "wayline_design_object", id="design-not-an-object"),
    pytest.param({"waypoints": []}, "wayline_waypoints_baked", id="no-waypoints"),
    pytest.param(
        {"waypoints": [{"position": [-4.72, 41.65]}]},
        "wayline_waypoints_baked",
        id="waypoint-without-height",
    ),
    pytest.param(
        {"metrics": {"waypoint_count": 2}},
        "wayline_metrics_object",
        id="metrics-without-distance",
    ),
    pytest.param(
        {"metrics": {"distance_m": 142.5}},
        "wayline_metrics_object",
        id="metrics-without-waypoint-count",
    ),
    pytest.param({"bake_version": " "}, "wayline_bake_version_given", id="blank-bake-version"),
]

# Anything that is not the shape each check names: never an error, always false.
ODD_JSON: list[str | None] = [
    None,
    "null",
    '"41.65,-4.72"',
    '{"position": [-4.72, 41.65], "height_m": 30}',
    "true",
    "1.5",
    "[]",
    "[null, null, null]",
    "[1, [2, 3]]",
    "[[[1, 2]]]",
    "[[1, 2], [3, 4]]",
    "[[[1, 2]], [[3, 4]], [[5, 6]]]",
    '[{"position": [-4.72, 41.65], "height_m": "30"}]',
    '[[{"position": [-4.72, 41.65], "height_m": 30}]]',
]


@pytest.fixture
async def soc_cloud(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
async def soc_operations(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_operations", service_passwords["soc_operations"])
    try:
        yield connection
    finally:
        await connection.close()


@asynccontextmanager
async def committed_as(
    session: asyncpg.Connection, user: uuid.UUID
) -> AsyncIterator[asyncpg.Connection]:
    """Acts as the user and keeps what was done, as a request through PostgREST does."""
    async with session.transaction():
        await impersonate(session, user)
        yield session


async def insert(
    session: asyncpg.Connection, member: Member, table: str, fields: dict[str, Any]
) -> asyncpg.Record:
    values = {"organization_id": member.organization_id, **fields}
    columns = ", ".join(values)
    placeholders = ", ".join(f"${index}" for index in range(1, len(values) + 1))
    encoded = [
        json.dumps(value) if column in JSON_COLUMNS else value for column, value in values.items()
    ]
    async with committed_as(session, member.user_id):
        row = await session.fetchrow(
            f"insert into soc.{table} ({columns}) values ({placeholders}) returning *",  # noqa: S608 - fixed names
            *encoded,
        )
    assert row is not None
    return row


async def draw(session: asyncpg.Connection, member: Member, **fields: Any) -> asyncpg.Record:
    return await insert(session, member, "geofences", {**DRAWN, **fields})


async def save(session: asyncpg.Connection, member: Member, **fields: Any) -> asyncpg.Record:
    return await insert(session, member, "waylines", {**SAVED, **fields})


async def change(
    session: asyncpg.Connection, member: Member, table: str, row_id: uuid.UUID, assignment: str
) -> None:
    async with committed_as(session, member.user_id):
        await session.execute(
            f"update soc.{table} set {assignment} where id = $1",  # noqa: S608 - fixed text
            row_id,
        )


async def viewer_of(tenancy: Tenancy, organization_id: uuid.UUID) -> Member:
    viewer = Member(await tenancy.user(), organization_id)
    await tenancy.join(viewer.user_id, organization_id, "viewer")
    return viewer


async def count_in(admin: asyncpg.Connection, table: str, organization: uuid.UUID) -> int:
    count = await admin.fetchval(
        f"select count(*) from soc.{table} where organization_id = $1",  # noqa: S608 - fixed names
        organization,
    )
    assert isinstance(count, int)
    return count


async def test_a_member_reads_their_organizations_geofences_and_waylines_and_nobody_elses(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner, stranger = await tenancy.member("owner"), await tenancy.member("owner")
    reader = await viewer_of(tenancy, owner.organization_id)
    geofence = await draw(session, owner)
    wayline = await save(session, owner)
    await draw(session, stranger)
    await save(session, stranger)
    async with acting_as(session, reader.user_id):
        geofences = await session.fetch("select id from soc.geofences")
        waylines = await session.fetch("select id from soc.waylines")
    assert [row["id"] for row in geofences] == [geofence["id"]]
    assert [row["id"] for row in waylines] == [wayline["id"]]
    async with acting_as(session, stranger.user_id):
        seen = await session.fetchval(
            "select count(*) from soc.geofences where organization_id = $1",
            owner.organization_id,
        )
    assert seen == 0


async def test_an_editor_draws_a_geofence_and_saves_a_wayline_as_written(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    geofence = await draw(session, editor)
    wayline = await save(session, editor)
    assert (geofence["name"], geofence["origin"], geofence["max_height_m"]) == (
        "Norte",
        "drawn",
        120,
    )
    assert (geofence["margin_m"], geofence["deleted_at"]) == (None, None)
    assert json.loads(geofence["polygon"]) == RING
    assert geofence["created_at"] == geofence["updated_at"]
    assert (wayline["name"], wayline["default_height_m"]) == ("Pasillo 1", 30)
    assert (wayline["bake_version"], wayline["deleted_at"]) == ("1", None)
    assert json.loads(wayline["takeoff"]) == TAKEOFF
    assert json.loads(wayline["design"]) == DESIGN
    assert json.loads(wayline["waypoints"]) == WAYPOINTS
    assert json.loads(wayline["metrics"]) == METRICS


async def test_a_viewer_cannot_create_a_geofence_or_a_wayline(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    viewer = await viewer_of(tenancy, owner.organization_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await draw(session, viewer)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await save(session, viewer)


async def test_a_viewers_change_or_retirement_touches_no_geofence_or_wayline(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    """Row security hides the rows from a viewer's update: no error, nothing changed."""
    owner = await tenancy.member("owner")
    viewer = await viewer_of(tenancy, owner.organization_id)
    geofence = await draw(session, owner)
    wayline = await save(session, owner)
    async with acting_as(session, viewer.user_id):
        for table, row_id in (("geofences", geofence["id"]), ("waylines", wayline["id"])):
            for assignment in ("name = 'Viewer was here'", "deleted_at = now()"):
                status = await session.execute(
                    f"update soc.{table} set {assignment} where id = $1",  # noqa: S608 - fixed text
                    row_id,
                )
                assert status == "UPDATE 0"
    async with acting_as(session, owner.user_id):
        kept_geofence = await session.fetchrow(
            "select name, deleted_at from soc.geofences where id = $1", geofence["id"]
        )
        kept_wayline = await session.fetchrow(
            "select name, deleted_at from soc.waylines where id = $1", wayline["id"]
        )
    assert kept_geofence is not None and kept_wayline is not None
    assert (kept_geofence["name"], kept_geofence["deleted_at"]) == ("Norte", None)
    assert (kept_wayline["name"], kept_wayline["deleted_at"]) == ("Pasillo 1", None)


@pytest.mark.parametrize(("fields", "named"), GEOFENCE_REFUSALS)
async def test_a_geofence_that_breaks_a_check_is_refused_by_that_checks_name(
    session: asyncpg.Connection, tenancy: Tenancy, fields: dict[str, Any], named: str
) -> None:
    editor = await tenancy.member("editor")
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await draw(session, editor, **fields)
    assert refusal.value.constraint_name == named


@pytest.mark.parametrize(("fields", "named"), WAYLINE_REFUSALS)
async def test_a_wayline_that_breaks_a_check_is_refused_by_that_checks_name(
    session: asyncpg.Connection, tenancy: Tenancy, fields: dict[str, Any], named: str
) -> None:
    editor = await tenancy.member("editor")
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await save(session, editor, **fields)
    assert refusal.value.constraint_name == named


@pytest.mark.parametrize(
    "metrics",
    [
        pytest.param({"waypoint_count": 2, "distance_m": 142.5}, id="without-a-duration"),
        pytest.param(
            {"waypoint_count": 2, "distance_m": 142.5, "duration_s": 38},
            id="with-a-duration-as-an-extra-key",
        ),
    ],
)
async def test_a_wayline_is_saved_with_its_waypoint_count_and_distance_and_no_duration(
    session: asyncpg.Connection, tenancy: Tenancy, metrics: dict[str, Any]
) -> None:
    """The duration is the operation's estimate (M4): a wayline's metrics do not require it."""
    editor = await tenancy.member("editor")
    wayline = await save(session, editor, metrics=metrics)
    assert json.loads(wayline["metrics"]) == metrics


async def test_a_wayline_has_no_speed_column_and_an_insert_naming_one_is_undefined(
    session: asyncpg.Connection, tenancy: Tenancy, admin: asyncpg.Connection
) -> None:
    """A speed belongs to the operation that flies the wayline (M4), not to the wayline."""
    named = await admin.fetchval(
        "select count(*) from information_schema.columns"
        " where table_schema = 'soc' and table_name = 'waylines' and column_name = 'speed_ms'"
    )
    assert named == 0
    editor = await tenancy.member("editor")
    with pytest.raises(asyncpg.UndefinedColumnError) as refusal:
        await insert(session, editor, "waylines", {**SAVED, "speed_ms": 5})
    assert refusal.value.sqlstate == "42703"
    assert "speed_ms" in refusal.value.message


@pytest.mark.parametrize("margin_m", [5, 100])
async def test_a_generated_geofence_keeps_its_margin_at_five_and_at_one_hundred_metres(
    session: asyncpg.Connection, tenancy: Tenancy, margin_m: int
) -> None:
    editor = await tenancy.member("editor")
    generated = await draw(session, editor, origin="generated", margin_m=margin_m)
    assert (generated["origin"], generated["margin_m"]) == ("generated", margin_m)


@pytest.mark.parametrize(
    ("position", "accepted"),
    [
        pytest.param([-4.72, 41.65], True, id="inside"),
        pytest.param([-180, -90], True, id="lower-bounds"),
        pytest.param([180, 90], True, id="upper-bounds"),
        pytest.param([180.0001, 0], False, id="longitude-past-180"),
        pytest.param([0, -90.0001], False, id="latitude-past-minus-90"),
        pytest.param([41.65, 181], False, id="latitude-written-first"),
        pytest.param([-4.72], False, id="one-number"),
        pytest.param([-4.72, 41.65, 0], False, id="three-numbers"),
        pytest.param(["-4.72", 41.65], False, id="a-string"),
    ],
)
async def test_a_position_is_longitude_then_latitude_within_range(
    session: asyncpg.Connection, position: list[Any], accepted: bool
) -> None:
    answer = await session.fetchval("select soc.is_position($1::jsonb)", json.dumps(position))
    assert answer is accepted


@pytest.mark.parametrize(
    ("ring", "accepted"),
    [
        pytest.param([[0, 0], [1, 0], [1, 1]], True, id="three-open-vertices"),
        pytest.param([[0, 0], [1, 0]], False, id="two-vertices"),
        pytest.param([[0, 0], [1, 0], [1, 1], [0, 0]], False, id="closed"),
        pytest.param([[0, 0], [1, 0], [0, 0]], False, id="closed-triangle"),
    ],
)
async def test_a_ring_has_three_or_more_positions_and_is_not_closed(
    session: asyncpg.Connection, ring: list[Any], accepted: bool
) -> None:
    answer = await session.fetchval("select soc.is_ring($1::jsonb)", json.dumps(ring))
    assert answer is accepted


@pytest.mark.parametrize(
    ("waypoints", "accepted"),
    [
        pytest.param(WAYPOINTS, True, id="baked"),
        pytest.param([], False, id="empty"),
        pytest.param([{"position": [-4.72, 41.65], "height_m": 0}], False, id="zero-height"),
        pytest.param([{"position": [-4.72, 41.65], "height_m": -1}], False, id="negative-height"),
        pytest.param([{"position": [-4.72, 41.65], "height_m": "30"}], False, id="height-as-text"),
        pytest.param(
            [{"position": [-4.72, 41.65], "height_m": 30}, 7], False, id="a-number-among-them"
        ),
        pytest.param([{"position": "-4.72,41.65", "height_m": 30}], False, id="position-as-text"),
    ],
)
async def test_baked_waypoints_are_positions_with_positive_heights(
    session: asyncpg.Connection, waypoints: list[Any], accepted: bool
) -> None:
    answer = await session.fetchval(
        "select soc.is_baked_waypoints($1::jsonb)", json.dumps(waypoints)
    )
    assert answer is accepted


async def test_the_shape_checks_accept_what_an_editor_saves(session: asyncpg.Connection) -> None:
    answers = await session.fetchrow(
        "select soc.is_position($1::jsonb) as position, soc.is_ring($2::jsonb) as ring,"
        " soc.is_baked_waypoints($3::jsonb) as waypoints",
        json.dumps(TAKEOFF),
        json.dumps(RING),
        json.dumps(WAYPOINTS),
    )
    assert answers is not None
    assert dict(answers) == {"position": True, "ring": True, "waypoints": True}


@pytest.mark.parametrize("value", ODD_JSON)
async def test_the_shape_checks_answer_false_on_odd_json_and_never_raise(
    session: asyncpg.Connection, value: str | None
) -> None:
    answers = await session.fetchrow(
        "select soc.is_position($1::jsonb) as position, soc.is_ring($1::jsonb) as ring,"
        " soc.is_baked_waypoints($1::jsonb) as waypoints",
        value,
    )
    assert answers is not None
    assert dict(answers) == {"position": False, "ring": False, "waypoints": False}


@pytest.mark.parametrize("table", ["geofences", "waylines"])
async def test_a_change_is_timed_by_the_database(
    session: asyncpg.Connection, tenancy: Tenancy, table: str
) -> None:
    editor = await tenancy.member("editor")
    row = await insert(session, editor, table, FIELDS[table])
    assert row["created_at"] == row["updated_at"]
    async with committed_as(session, editor.user_id):
        changed = await session.fetchrow(
            f"update soc.{table} set name = 'Renamed' where id = $1"  # noqa: S608 - fixed names
            " returning created_at, updated_at, now() as database_now",
            row["id"],
        )
    assert changed is not None
    assert changed["updated_at"] == changed["database_now"]
    assert changed["created_at"] == row["created_at"] < changed["updated_at"]


@pytest.mark.parametrize("table", ["geofences", "waylines"])
async def test_retiring_is_final_and_timed_by_the_database(
    session: asyncpg.Connection, tenancy: Tenancy, table: str
) -> None:
    editor = await tenancy.member("editor")
    kind = table.removesuffix("s")
    row = await insert(session, editor, table, FIELDS[table])
    async with committed_as(session, editor.user_id):
        retired = await session.fetchrow(
            f"update soc.{table} set deleted_at = '2000-01-01' where id = $1"  # noqa: S608 - fixed names
            " returning deleted_at, now() as database_now",
            row["id"],
        )
    assert retired is not None
    assert retired["deleted_at"] == retired["database_now"]
    for assignment in ("name = 'Back'", "deleted_at = null"):
        async with acting_as(session, editor.user_id):
            with pytest.raises(asyncpg.CheckViolationError) as refusal:
                await session.execute(
                    f"update soc.{table} set {assignment} where id = $1",  # noqa: S608 - fixed text
                    row["id"],
                )
        assert str(refusal.value) == f"{kind} {row['id']}: a retired {kind} does not change"
    async with acting_as(session, editor.user_id):
        kept = await session.fetchval(f"select count(*) from soc.{table} where id = $1", row["id"])  # noqa: S608 - fixed names
    assert kept == 1


async def test_an_editor_edits_but_cannot_move_a_geofence_or_a_wayline_to_another_organization(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    geofence = await draw(session, editor)
    wayline = await save(session, editor)
    async with acting_as(session, editor.user_id):
        renamed = await session.fetchval(
            "update soc.geofences set name = 'Norte Alfa' where id = $1 returning name",
            geofence["id"],
        )
    assert renamed == "Norte Alfa"
    for table, row_id in (("geofences", geofence["id"]), ("waylines", wayline["id"])):
        async with acting_as(session, editor.user_id):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await session.execute(
                    f"update soc.{table} set organization_id = $2 where id = $1",  # noqa: S608 - fixed names
                    row_id,
                    uuid.uuid4(),
                )


async def test_a_saved_wayline_keeps_the_waypoints_it_was_saved_with(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    """IR-WAY-01: nothing recomputes the bake; only an editor writing new waypoints changes them."""
    editor = await tenancy.member("editor")
    wayline = await save(session, editor)
    async with committed_as(session, editor.user_id):
        renamed = await session.fetchrow(
            "update soc.waylines set name = 'Pasillo bis' where id = $1 returning waypoints",
            wayline["id"],
        )
    assert renamed is not None
    assert json.loads(renamed["waypoints"]) == WAYPOINTS
    rebaked = [{"position": [-4.7241, 41.6500], "height_m": 40, "actions": []}]
    async with committed_as(session, editor.user_id):
        written = await session.fetchval(
            "update soc.waylines set waypoints = $2::jsonb where id = $1 returning waypoints",
            wayline["id"],
            json.dumps(rebaked),
        )
    assert json.loads(written) == rebaked


async def test_every_insert_and_update_reaches_the_organizations_state_topic(
    todays_partition: None,
    session: asyncpg.Connection,
    tenancy: Tenancy,
    admin: asyncpg.Connection,
) -> None:
    editor = await tenancy.member("editor")
    geofence = await draw(session, editor)
    await change(session, editor, "geofences", geofence["id"], "name = 'Norte bis'")
    wayline = await save(session, editor)
    await change(session, editor, "waylines", wayline["id"], "name = 'Pasillo bis'")
    await change(session, editor, "geofences", geofence["id"], "deleted_at = now()")
    rows = await admin.fetch(
        "select event, private, payload from realtime.messages"
        " where topic = $1 order by inserted_at, id",
        f"org:{editor.organization_id}:soc:state",
    )
    assert [row["event"] for row in rows] == [
        "geofence",
        "geofence",
        "wayline",
        "wayline",
        "geofence",
    ]
    assert all(row["private"] for row in rows)
    payloads = [json.loads(row["payload"]) for row in rows]
    assert [set(payload) for payload in payloads] == [
        GEOFENCE_KEYS,
        GEOFENCE_KEYS,
        WAYLINE_KEYS,
        WAYLINE_KEYS,
        GEOFENCE_KEYS,
    ]
    assert [(payload["id"], payload["name"]) for payload in payloads] == [
        (str(geofence["id"]), "Norte"),
        (str(geofence["id"]), "Norte bis"),
        (str(wayline["id"]), "Pasillo 1"),
        (str(wayline["id"]), "Pasillo bis"),
        (str(geofence["id"]), "Norte bis"),
    ]
    assert [payload["origin"] for payload in payloads if "origin" in payload] == [
        "drawn",
        "drawn",
        "drawn",
    ]
    assert [payload["deleted_at"] is None for payload in payloads] == [
        True,
        True,
        True,
        True,
        False,
    ]
    stored = await admin.fetchrow(
        "select updated_at, deleted_at from soc.geofences where id = $1", geofence["id"]
    )
    assert stored is not None
    assert datetime.fromisoformat(payloads[-1]["updated_at"]) == stored["updated_at"]
    assert datetime.fromisoformat(payloads[-1]["deleted_at"]) == stored["deleted_at"]


async def test_an_organization_deleted_takes_its_geofences_and_waylines(
    session: asyncpg.Connection,
    tenancy: Tenancy,
    admin: asyncpg.Connection,
) -> None:
    editor = await tenancy.member("editor")
    await draw(session, editor)
    await save(session, editor)
    assert await count_in(admin, "geofences", editor.organization_id) == 1
    assert await count_in(admin, "waylines", editor.organization_id) == 1
    await admin.execute("delete from public.organizations where id = $1", editor.organization_id)
    assert await count_in(admin, "geofences", editor.organization_id) == 0
    assert await count_in(admin, "waylines", editor.organization_id) == 0


async def test_soc_cloud_and_soc_operations_read_every_geofence_and_wayline_and_write_none(
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    soc_operations: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    editor, other = await tenancy.member("editor"), await tenancy.member("editor")
    geofence = await draw(session, editor)
    wayline = await save(session, editor)
    other_geofence = await draw(session, other)
    statements: list[tuple[str, tuple[Any, ...]]] = [
        ("update soc.geofences set name = 'x' where id = $1", (geofence["id"],)),
        ("update soc.waylines set name = 'x' where id = $1", (wayline["id"],)),
        (
            "insert into soc.waylines (organization_id, name) values ($1, 'x')",
            (other.organization_id,),
        ),
    ]
    for service in (soc_cloud, soc_operations):
        geofences = {row["id"] for row in await service.fetch("select id from soc.geofences")}
        waylines = {row["id"] for row in await service.fetch("select id from soc.waylines")}
        assert {geofence["id"], other_geofence["id"]} <= geofences
        assert wayline["id"] in waylines
        for statement, args in statements:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await service.execute(statement, *args)
