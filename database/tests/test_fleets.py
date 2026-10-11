from __future__ import annotations

import json
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as, impersonate

MODEL = "mavic-air-2"


def serial() -> str:
    return secrets.token_hex(6).upper()


@pytest.fixture
async def soc_cloud(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
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


def aircraft(sn: str, online: bool = True) -> dict[str, Any]:
    return {"aircraft_sn": sn, "domain": 0, "type": 67, "sub_type": 0, "online": online}


async def stack_of(soc_cloud: asyncpg.Connection, organization: uuid.UUID, *sns: str) -> str:
    gateway = serial()
    await soc_cloud.execute(
        "select soc.record_stack($1, 'lab', $2, 'connected')", gateway, organization
    )
    await soc_cloud.fetchval(
        "select soc.record_topology($1, $2::jsonb)",
        gateway,
        json.dumps([aircraft(sn) for sn in sns]),
    )
    return gateway


async def register(
    session: asyncpg.Connection, member: Member, gateway: str, aircraft_sn: str, **fields: Any
) -> asyncpg.Record:
    values = {
        "organization_id": member.organization_id,
        "name": "Norte 1",
        "model": MODEL,
        "airframe_serial": "1WNBH9",
        "gateway_sn": gateway,
        "aircraft_sn": aircraft_sn,
        **fields,
    }
    columns = ", ".join(values)
    placeholders = ", ".join(f"${index}" for index in range(1, len(values) + 1))
    async with committed_as(session, member.user_id):
        row = await session.fetchrow(
            f"insert into soc.fleets ({columns}) values ({placeholders}) returning *",  # noqa: S608 - fixed names
            *values.values(),
        )
    assert row is not None
    return row


async def devices(session: asyncpg.Connection, member: Member) -> dict[str, bool]:
    async with acting_as(session, member.user_id):
        rows = await session.fetch("select aircraft_sn, online from soc.devices")
    return {row["aircraft_sn"]: row["online"] for row in rows}


async def test_a_member_sees_their_stacks_devices_and_nobody_elses(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, stranger = await tenancy.member("viewer"), await tenancy.member("viewer")
    gateway = await stack_of(soc_cloud, member.organization_id, "AIRCRAFT1")
    await stack_of(soc_cloud, stranger.organization_id, "AIRCRAFT2")
    async with acting_as(session, member.user_id):
        stacks = await session.fetch("select gateway_sn, link_state from soc.stacks")
    assert [(row["gateway_sn"], row["link_state"]) for row in stacks] == [(gateway, "connected")]
    assert await devices(session, member) == {"AIRCRAFT1": True}


async def test_an_aircraft_is_online_only_while_its_stack_lists_it_online(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("viewer")
    gateway = await stack_of(soc_cloud, member.organization_id, "AIRCRAFT1", "AIRCRAFT2")
    topology = "select soc.record_topology($1, $2::jsonb)"
    online = await soc_cloud.fetchval(
        topology, gateway, json.dumps([aircraft("AIRCRAFT1", online=False)])
    )
    assert online == 0
    assert await devices(session, member) == {"AIRCRAFT1": False, "AIRCRAFT2": False}
    assert await soc_cloud.fetchval(topology, gateway, json.dumps([aircraft("AIRCRAFT2")])) == 1
    assert await devices(session, member) == {"AIRCRAFT1": False, "AIRCRAFT2": True}


async def test_a_device_keeps_when_it_was_first_seen(
    soc_cloud: asyncpg.Connection, tenancy: Tenancy, admin: asyncpg.Connection
) -> None:
    member = await tenancy.member()
    gateway = await stack_of(soc_cloud, member.organization_id, "AIRCRAFT1")
    first = await admin.fetchrow(
        "select first_seen_at, last_seen_at from soc.devices where gateway_sn = $1", gateway
    )
    await soc_cloud.fetchval(
        "select soc.record_topology($1, $2::jsonb)", gateway, json.dumps([aircraft("AIRCRAFT1")])
    )
    later = await admin.fetchrow(
        "select first_seen_at, last_seen_at from soc.devices where gateway_sn = $1", gateway
    )
    assert first is not None and later is not None
    assert later["first_seen_at"] == first["first_seen_at"]
    assert later["last_seen_at"] >= first["last_seen_at"]


async def test_an_editor_registers_a_fleet_from_a_device_seen(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    fleet = await register(session, editor, gateway, "AIRCRAFT1", controller_serial="RC123")
    assert (fleet["model"], fleet["deleted_at"], fleet["flight_time_before_soc_s"]) == (
        MODEL,
        None,
        0,
    )


async def test_a_viewer_cannot_register_a_fleet(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    viewer = await tenancy.member("viewer")
    gateway = await stack_of(soc_cloud, viewer.organization_id, "AIRCRAFT1")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await register(session, viewer, gateway, "AIRCRAFT1")


async def test_a_device_of_another_organizations_stack_cannot_be_registered(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor, other = await tenancy.member("editor"), await tenancy.member("owner")
    gateway = await stack_of(soc_cloud, other.organization_id, "AIRCRAFT1")
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await register(session, editor, gateway, "AIRCRAFT1")


async def test_a_device_with_a_live_fleet_cannot_be_registered_again(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    await register(session, editor, gateway, "AIRCRAFT1")
    with pytest.raises(asyncpg.UniqueViolationError):
        await register(session, editor, gateway, "AIRCRAFT1", name="Norte 2")


@pytest.mark.parametrize(
    ("fields", "named"),
    [
        ({"name": " "}, "fleet_name_given"),
        ({"model": None}, "model"),
        ({"model": "not-a-model"}, "fleets_model_fkey"),
        ({"airframe_serial": ""}, "fleet_airframe_serial_given"),
    ],
)
async def test_a_fleet_without_a_name_model_or_airframe_serial_is_refused_by_name(
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    tenancy: Tenancy,
    fields: dict[str, Any],
    named: str,
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    with pytest.raises(asyncpg.IntegrityConstraintViolationError) as refusal:
        await register(session, editor, gateway, "AIRCRAFT1", **fields)
    assert named in str(refusal.value) + (refusal.value.constraint_name or "")


async def test_retiring_is_final_keeps_the_fleet_and_frees_its_device(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    fleet = await register(session, editor, gateway, "AIRCRAFT1")
    async with committed_as(session, editor.user_id):
        retired = await session.fetchrow(
            "update soc.fleets set deleted_at = '2000-01-01' where id = $1 returning deleted_at",
            fleet["id"],
        )
    assert retired is not None and retired["deleted_at"].year > 2000
    for change in ("name = 'Back'", "deleted_at = null"):
        async with acting_as(session, editor.user_id):
            with pytest.raises(asyncpg.CheckViolationError):
                await session.execute(
                    f"update soc.fleets set {change} where id = $1",  # noqa: S608 - fixed text
                    fleet["id"],
                )
    async with acting_as(session, editor.user_id):
        assert (
            await session.fetchval("select count(*) from soc.fleets where id = $1", fleet["id"])
            == 1
        )
    await register(session, editor, gateway, "AIRCRAFT1", name="Norte 1 bis")


async def test_an_editor_edits_but_cannot_move_a_fleet_to_another_organization(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    fleet = await register(session, editor, gateway, "AIRCRAFT1")
    async with acting_as(session, editor.user_id):
        renamed = await session.fetchval(
            "update soc.fleets set name = 'Norte Alfa', flight_time_before_soc_s = 3600"
            " where id = $1 returning name",
            fleet["id"],
        )
        assert renamed == "Norte Alfa"
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await session.execute(
                "update soc.fleets set organization_id = $2 where id = $1",
                fleet["id"],
                uuid.uuid4(),
            )


async def test_a_viewers_change_or_retirement_touches_no_row(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    """Row security hides the row from a viewer's update: no error, nothing changed.

    The console counts the rows a write returned to tell this apart from a change.
    """
    owner = await tenancy.member("owner")
    viewer = Member(await tenancy.user(), owner.organization_id)
    await tenancy.join(viewer.user_id, viewer.organization_id, "viewer")
    gateway = await stack_of(soc_cloud, owner.organization_id, "AIRCRAFT1")
    fleet = await register(session, owner, gateway, "AIRCRAFT1")
    async with acting_as(session, viewer.user_id):
        for change in ("name = 'Viewer was here'", "deleted_at = now()"):
            status = await session.execute(
                f"update soc.fleets set {change} where id = $1",  # noqa: S608 - fixed text
                fleet["id"],
            )
            assert status == "UPDATE 0"
    async with acting_as(session, owner.user_id):
        kept = await session.fetchrow(
            "select name, deleted_at from soc.fleets where id = $1", fleet["id"]
        )
    assert kept is not None and (kept["name"], kept["deleted_at"]) == ("Norte 1", None)


async def test_only_soc_cloud_records_what_stacks_report(
    session: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    gateway = await stack_of(soc_cloud, owner.organization_id, "AIRCRAFT1")
    for statement in (
        "select soc.record_topology('X', '[]')",
        "select soc.record_stack('X', 'lab', gen_random_uuid(), 'connected')",
        "select soc.record_firmware('X', 'Y', '1.0')",
        f"update soc.devices set online = false where gateway_sn = '{gateway}'",  # noqa: S608
    ):
        async with acting_as(session, owner.user_id):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await session.execute(statement)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.execute("update soc.fleets set name = 'x'")


async def test_every_change_reaches_the_organizations_state_topic(
    todays_partition: None,
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    tenancy: Tenancy,
    admin: asyncpg.Connection,
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    await soc_cloud.execute("select soc.record_firmware($1, 'AIRCRAFT1', '02.04.0300')", gateway)
    await soc_cloud.fetchval("select soc.record_topology($1, '[]'::jsonb)", gateway)
    await soc_cloud.fetchval(
        "select soc.record_topology($1, $2::jsonb)", gateway, json.dumps([aircraft("AIRCRAFT1")])
    )
    await register(session, editor, gateway, "AIRCRAFT1")
    rows = await admin.fetch(
        "select event, payload from realtime.messages where topic = $1 order by inserted_at, id",
        f"org:{editor.organization_id}:soc:state",
    )
    seen = [(row["event"], json.loads(row["payload"]).get("online")) for row in rows]
    assert seen == [
        ("stack", None),
        ("device", True),
        ("device", True),
        ("device", False),
        ("device", True),
        ("fleet", None),
    ]


async def test_an_organization_deleted_takes_its_stacks_devices_and_fleets(
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    tenancy: Tenancy,
    admin: asyncpg.Connection,
) -> None:
    editor = await tenancy.member("editor")
    gateway = await stack_of(soc_cloud, editor.organization_id, "AIRCRAFT1")
    await register(session, editor, gateway, "AIRCRAFT1")
    await admin.execute("delete from public.organizations where id = $1", editor.organization_id)
    for table in ("stacks", "devices", "fleets"):
        count = await admin.fetchval(
            f"select count(*) from soc.{table} where gateway_sn = $1",  # noqa: S608 - fixed names
            gateway,
        )
        assert count == 0, table
