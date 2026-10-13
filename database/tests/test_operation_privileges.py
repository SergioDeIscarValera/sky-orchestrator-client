from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Operations, Tenancy, acting_as

ROLES = ["authenticated", "soc_cloud", "soc_operations"]
# Each function, with the roles migration 0010 grants its EXECUTE to. Every other role has none.
GRANTS = [
    pytest.param(
        "soc.move_operation(uuid,soc.operation_state,text,soc.event_source,uuid,soc.end_reason)",
        {"soc_operations"},
        id="move_operation",
    ),
    pytest.param(
        "soc.log_event(uuid,text,soc.event_source,jsonb,uuid,uuid,uuid,uuid,timestamptz,"
        "soc.event_severity)",
        {"soc_operations", "soc_cloud"},
        id="log_event",
    ),
    pytest.param(
        "soc.definition_changed(uuid,text,uuid)", {"soc_operations"}, id="definition_changed"
    ),
    pytest.param(
        "soc.request_transition(uuid,soc.transition,uuid,jsonb)",
        {"authenticated"},
        id="request_transition",
    ),
    pytest.param(
        "soc.request_command(uuid,soc.command_verb,uuid,jsonb)",
        {"authenticated"},
        id="request_command",
    ),
    pytest.param(
        "soc.claim_transition_request(uuid,integer)",
        {"soc_operations"},
        id="claim_transition_request",
    ),
    pytest.param(
        "soc.decide_transition_request(uuid,soc.request_status,jsonb)",
        {"soc_operations"},
        id="decide_transition_request",
    ),
    pytest.param("soc.record_checks(uuid,jsonb)", {"soc_operations"}, id="record_checks"),
    pytest.param(
        "soc.record_aircraft_sample(text,text,jsonb,timestamptz)",
        {"soc_cloud"},
        id="record_aircraft_sample",
    ),
    pytest.param("soc.record_stack_status(text,jsonb)", {"soc_cloud"}, id="record_stack_status"),
    pytest.param(
        "soc.record_stack_envelope(text,jsonb)", {"soc_cloud"}, id="record_stack_envelope"
    ),
    pytest.param(
        "soc.record_flight_progress(uuid,soc.flight_status,integer,integer,integer,jsonb,"
        "soc.end_reason)",
        {"soc_cloud"},
        id="record_flight_progress",
    ),
    pytest.param(
        "soc.record_flight_moment(uuid,text,timestamptz,integer)",
        {"soc_cloud"},
        id="record_flight_moment",
    ),
    pytest.param(
        "soc.record_dry_run(uuid,soc.dry_run_status,jsonb)", {"soc_cloud"}, id="record_dry_run"
    ),
    pytest.param(
        "soc.record_stack_files_url(text,text)", {"soc_cloud"}, id="record_stack_files_url"
    ),
    pytest.param(
        "soc.is_terminal(soc.operation_state)",
        {"authenticated", "soc_cloud", "soc_operations"},
        id="is_terminal",
    ),
    pytest.param(
        "soc.is_frozen(soc.operation_state)",
        {"authenticated", "soc_cloud", "soc_operations"},
        id="is_frozen",
    ),
    pytest.param("soc.commanding_pilots(uuid)", {"soc_operations"}, id="commanding_pilots"),
    pytest.param("soc.organization_members(uuid)", {"authenticated"}, id="organization_members"),
    pytest.param("soc.is_open(uuid)", {"soc_cloud", "soc_operations"}, id="is_open"),
    pytest.param(
        "soc.record_geofence_breach(uuid,uuid,jsonb,timestamptz)",
        {"soc_cloud"},
        id="record_geofence_breach",
    ),
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


@pytest.mark.parametrize(("signature", "allowed"), GRANTS)
async def test_only_the_roles_named_for_a_function_may_execute_it(
    signature: str, allowed: set[str], admin: asyncpg.Connection
) -> None:
    for role in ROLES:
        may = await admin.fetchval(
            "select has_function_privilege($1, $2::regprocedure, 'EXECUTE')", role, signature
        )
        assert may is (role in allowed), f"{role} on {signature}"


async def test_an_editor_cannot_move_an_operation_or_record_a_flight(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(
                "select soc.move_operation($1, 'planned', 'editor', 'operator')", flown.operation_id
            )
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(
                "select soc.record_flight_moment($1, 'landed', now(), 1)", flown.flight_id
            )


async def test_soc_cloud_cannot_move_an_operation_or_record_checks(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.execute(
            "select soc.move_operation($1, 'planned', 'x', 'soc-cloud')", flown.operation_id
        )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.execute("select soc.record_checks($1, '[]'::jsonb)", flown.operation_id)


async def test_soc_operations_cannot_record_the_stacks_or_the_flights_progress(
    soc_operations: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_operations.execute(
            "select soc.record_aircraft_sample($1, $2, '{}'::jsonb, now())",
            flown.aircraft_sn,
            flown.gateway_sn,
        )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_operations.execute(
            "select soc.record_flight_progress($1, 'ok', 0, 100, 0, null)", flown.flight_id
        )


async def test_no_stranger_can_request_a_command_or_a_move_of_another_organization(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    stranger = await tenancy.user()
    async with acting_as(session, stranger) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(
                "select * from soc.request_command($1, 'pause', $2, '{}'::jsonb)",
                flown.flight_id,
                uuid.uuid4(),
            )
