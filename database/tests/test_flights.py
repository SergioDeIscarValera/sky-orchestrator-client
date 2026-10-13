from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Flown, Operations, Tenancy, acting_as

FILE = b"PK\x03\x04kmz"
SQUARE = [[-4.7255, 41.6515], [-4.7235, 41.6515], [-4.7235, 41.6531], [-4.7255, 41.6531]]
INSERT_FILE = (
    "insert into soc.flight_files (organization_id, operation_id, wayline_id, bytes, md5,"
    " size_bytes, profile_version, token) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id"
)
READ_BYTES = "select bytes from soc.flight_files where id = $1"
READ_TOKEN = "select token from soc.flight_files where id = $1"
INSERT_FLIGHT = (
    "insert into soc.flights (organization_id, operation_id, assignment_id, fleet_id, gateway_sn,"
    " aircraft_sn, mode, file_id, geofence_snapshot, envelope_snapshot)"
    " values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb) returning id"
)


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


def md5_of(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()  # noqa: S324 - DJI's fingerprint, as the database checks it


def announced(aircraft: str) -> dict[str, Any]:
    return {"aircraft_sn": aircraft, "domain": 0, "type": 67, "sub_type": 0, "online": True}


def aircraft_sn() -> str:
    return f"SOUAV{secrets.token_hex(4).upper()}"


async def test_a_flight_file_of_its_own_bytes_is_accepted(
    soc_operations: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    flown = await Operations(admin).flown(organization)
    file_id = await soc_operations.fetchval(
        INSERT_FILE,
        organization,
        flown.operation_id,
        flown.wayline_id,
        FILE,
        md5_of(FILE),
        len(FILE),
        "1.0.0",
        secrets.token_hex(16),
    )
    assert file_id is not None


@pytest.mark.parametrize(
    ("md5", "size", "token", "profile", "constraint"),
    [
        pytest.param("0" * 32, len(FILE), None, "1.0.0", "flight_file_md5_of_bytes", id="md5"),
        pytest.param(
            md5_of(FILE), len(FILE) + 1, None, "1.0.0", "flight_file_size_of_bytes", id="size"
        ),
        pytest.param(
            md5_of(FILE),
            len(FILE),
            "abc123",
            "1.0.0",
            "flight_file_token_unguessable",
            id="short-token",
        ),
        pytest.param(
            md5_of(FILE),
            len(FILE),
            "A" * 32,
            "1.0.0",
            "flight_file_token_unguessable",
            id="32-characters-not-lower-hex",
        ),
        pytest.param(
            md5_of(FILE), len(FILE), None, " ", "flight_file_profile_given", id="blank-profile"
        ),
    ],
)
async def test_a_flight_file_names_its_own_bytes_and_an_unguessable_token(
    md5: str,
    size: int,
    token: str | None,
    profile: str,
    constraint: str,
    soc_operations: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    organization = (await tenancy.member()).organization_id
    flown = await Operations(admin).flown(organization)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await soc_operations.fetchval(
            INSERT_FILE,
            organization,
            flown.operation_id,
            flown.wayline_id,
            FILE,
            md5,
            size,
            profile,
            token or secrets.token_hex(16),
        )
    assert refusal.value.constraint_name == constraint


async def test_a_member_reads_a_flight_files_identity_and_never_its_bytes_or_token(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        identity = await connection.fetchrow(
            "select md5, size_bytes, profile_version from soc.flight_files where id = $1",
            flown.file_id,
        )
    assert identity is not None
    assert (identity["md5"], identity["size_bytes"], identity["profile_version"]) == (
        md5_of(FILE),
        len(FILE),
        "1.0.0",
    )
    for withheld in (READ_BYTES, READ_TOKEN):
        async with acting_as(session, member.user_id) as connection:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await connection.fetchval(withheld, flown.file_id)


async def test_soc_cloud_reads_the_bytes_and_the_token_it_serves(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    served = await admin.fetchrow("select token from soc.flight_files where id = $1", flown.file_id)
    assert served is not None
    row = await soc_cloud.fetchrow(
        "select bytes, token from soc.flight_files where id = $1", flown.file_id
    )
    assert row is not None
    assert (bytes(row["bytes"]), row["token"]) == (FILE, served["token"])


async def test_no_role_but_the_administrator_rewrites_a_flight_file(
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    soc_operations: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    statement = "update soc.flight_files set bytes = $2 where id = $1"
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(statement, flown.file_id, b"rebuilt")
    for service in (soc_cloud, soc_operations):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await service.execute(statement, flown.file_id, b"rebuilt")
    kept = await admin.fetchval("select bytes from soc.flight_files where id = $1", flown.file_id)
    assert bytes(kept) == FILE


@pytest.mark.parametrize(
    ("mode", "refusal"),
    [
        pytest.param("unknown", asyncpg.InvalidTextRepresentationError, id="unknown"),
        pytest.param(None, asyncpg.NotNullViolationError, id="not-given"),
    ],
)
async def test_a_flight_records_simulated_or_real_and_nothing_else(
    mode: str | None,
    refusal: type[asyncpg.PostgresError],
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    with pytest.raises(refusal):
        await admin.execute(
            INSERT_FLIGHT,
            flown.organization_id,
            flown.operation_id,
            flown.assignment_id,
            flown.fleet_id,
            flown.gateway_sn,
            flown.aircraft_sn,
            mode,
            flown.file_id,
            json.dumps({"polygon": SQUARE, "max_height_m": 120}),
        )


@pytest.mark.parametrize(
    "snapshot",
    [
        pytest.param({"max_height_m": 120}, id="no-polygon"),
        pytest.param({"polygon": SQUARE, "max_height_m": "120"}, id="ceiling-as-text"),
    ],
)
async def test_a_flight_keeps_the_geofence_it_was_prepared_against(
    snapshot: dict[str, Any],
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await admin.execute(
            INSERT_FLIGHT,
            flown.organization_id,
            flown.operation_id,
            flown.assignment_id,
            flown.fleet_id,
            flown.gateway_sn,
            flown.aircraft_sn,
            "simulated",
            flown.file_id,
            json.dumps(snapshot),
        )
    assert refusal.value.constraint_name == "flight_geofence_snapshot"


async def test_a_fleets_wire_identity_cannot_move_while_its_flight_has_not_ended(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown: Flown = await Operations(admin).flown(member.organization_id)
    spare = aircraft_sn()
    await admin.execute(
        "select soc.record_topology($1, $2::jsonb)",
        flown.gateway_sn,
        json.dumps([announced(flown.aircraft_sn), announced(spare)]),
    )
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            await connection.execute(
                "update soc.fleets set aircraft_sn = $2 where id = $1", flown.fleet_id, spare
            )
    assert refusal.value.constraint_name == "fleet_identity_in_flight"


async def test_a_fleets_wire_identity_moves_once_its_flight_has_ended(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    spare = aircraft_sn()
    await admin.execute(
        "select soc.record_topology($1, $2::jsonb)",
        flown.gateway_sn,
        json.dumps([announced(flown.aircraft_sn), announced(spare)]),
    )
    await admin.execute(
        "update soc.flights set ended_at = now(), end_reason = 'operator_return' where id = $1",
        flown.flight_id,
    )
    async with acting_as(session, member.user_id) as connection:
        moved = await connection.fetchval(
            "update soc.fleets set aircraft_sn = $2 where id = $1 returning aircraft_sn",
            flown.fleet_id,
            spare,
        )
    assert moved == spare


async def test_a_closed_operation_takes_no_new_flight_file_or_dry_run(
    soc_operations: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    await Operations(admin).move(
        flown.operation_id,
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
    with pytest.raises(asyncpg.CheckViolationError) as file_refusal:
        await soc_operations.fetchval(
            INSERT_FILE,
            flown.organization_id,
            flown.operation_id,
            flown.wayline_id,
            FILE,
            md5_of(FILE),
            len(FILE),
            "1.0.0",
            secrets.token_hex(16),
        )
    assert file_refusal.value.constraint_name == "operation_closed"
    with pytest.raises(asyncpg.CheckViolationError) as run_refusal:
        await soc_operations.execute(
            "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)",
            flown.organization_id,
            flown.file_id,
            flown.gateway_sn,
        )
    assert run_refusal.value.constraint_name == "operation_closed"


FLIGHT_BROADCAST_KEYS = {
    "id",
    "operation_id",
    "mode",
    "executed_at",
    "took_off_at",
    "landed_at",
    "breached_at",
    "ended_at",
    "end_reason",
}


async def test_the_flight_broadcast_keeps_the_keys_the_console_reads(
    todays_partition: None, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await admin.execute(
        "update soc.flights set ended_at = now(), end_reason = 'operator_return' where id = $1",
        flown.flight_id,
    )
    rows = await admin.fetch(
        "select payload from realtime.messages where topic = $1 and event = 'flight'"
        " order by inserted_at, id",
        f"org:{member.organization_id}:soc:state",
    )
    payloads = [json.loads(row["payload"]) for row in rows]
    assert [set(payload) for payload in payloads][-1] == FLIGHT_BROADCAST_KEYS


async def test_a_flight_keeps_when_it_was_breached_as_a_nullable_timestamp(
    admin: asyncpg.Connection,
) -> None:
    column = await admin.fetchrow(
        "select data_type, is_nullable from information_schema.columns"
        " where table_schema = 'soc' and table_name = 'flights' and column_name = 'breached_at'"
    )
    assert column is not None
    assert (column["data_type"], column["is_nullable"]) == ("timestamp with time zone", "YES")
