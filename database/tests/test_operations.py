from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_database.harness import (
    EphemeralPostgres,
    Flown,
    Operations,
    Tenancy,
    acting_as,
    impersonate,
)

LIFECYCLE = Path(__file__).resolve().parents[2] / "contracts" / "operations" / "lifecycle.json"
CONTRACT: dict[str, Any] = json.loads(LIFECYCLE.read_text(encoding="utf-8"))
STATES: list[str] = CONTRACT["states"]
MOVES = {(move["from"], move["to"]) for move in CONTRACT["transitions"]}
TERMINAL_STATES = ["completed", "aborted", "failed", "cancelled"]
PASSING_STATES = ["draft", "planned"]
ACTIVE_STATES = ["preparing", "simulated", "ready"]
FROZEN_STATES = ["simulating", "launching", "in_flight", "paused", "returning"]
END_REASON = {
    "completed": "completed",
    "cancelled": "cancelled",
    "aborted": "operator_stop",
    "failed": "link_lost",
}
DRAWN_RING = [[-4.7260, 41.6520], [-4.7200, 41.6520], [-4.7200, 41.6480], [-4.7260, 41.6480]]

MOVE = (
    "select soc.move_operation($1, $2::soc.operation_state, $3, 'soc-operations', null,"
    " $4::soc.end_reason)"
)
FORCE = """
update soc.operations
   set state = $2::soc.operation_state,
       ended_at = case when soc.is_terminal($2::soc.operation_state) then now() end,
       end_reason = case when soc.is_terminal($2::soc.operation_state) then $3::soc.end_reason end
 where id = $1
"""
STATE_EVENTS = (
    "select payload from soc.operation_events where operation_id = $1"
    " and kind = 'operation_state_changed' order by recorded_at, id"
)
DEFINITION_EVENTS = (
    "select payload from soc.operation_events where operation_id = $1"
    " and kind = 'operation_definition_changed' order by recorded_at, id"
)
GEOFENCE_CHANGE = "update soc.operations set geofence_id = $2 where id = $1"
HEIGHT_CHANGE = "update soc.operations set takeoff_security_height_m = 40 where id = $1"
ADD_ASSIGNMENT = (
    "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id, speed_ms)"
    " values ($1, $2, $3, $4, 5)"
)
ASSIGNMENT_CHANGES = ["speed", "flight", "add", "remove"]
DEPENDENTS = {
    "wayline": "update soc.waylines set default_height_m = 31 where id = $1",
    "geofence": "update soc.geofences set max_height_m = 110 where id = $1",
    "fleet": "update soc.fleets set model = $2 where id = $1",
}


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
async def rolled_back(connection: asyncpg.Connection) -> AsyncIterator[asyncpg.Connection]:
    """Everything done inside the block is undone when it ends."""
    transaction = connection.transaction()
    await transaction.start()
    try:
        yield connection
    finally:
        await transaction.rollback()


async def refusal_of(statement: Awaitable[object]) -> asyncpg.PostgresError:
    """The database's refusal of the statement; an AssertionError when it accepts it."""
    try:
        await statement
    except asyncpg.PostgresError as refusal:
        return refusal
    raise AssertionError("the database accepted a statement it must refuse")


async def operation_in(
    admin: asyncpg.Connection, organization_id: uuid.UUID, geofence_id: uuid.UUID | None = None
) -> uuid.UUID:
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name, geofence_id, takeoff_security_height_m)"
        " values ($1, 'Norte', $2, 20) returning id",
        organization_id,
        geofence_id,
    )
    assert isinstance(operation, uuid.UUID)
    return operation


async def geofence_in(admin: asyncpg.Connection, organization_id: uuid.UUID) -> uuid.UUID:
    geofence = await admin.fetchval(
        "insert into soc.geofences (organization_id, name, polygon, max_height_m, origin)"
        " values ($1, 'Norte', $2::jsonb, 120, 'drawn') returning id",
        organization_id,
        json.dumps(DRAWN_RING),
    )
    assert isinstance(geofence, uuid.UUID)
    return geofence


async def force(admin: asyncpg.Connection, operation: uuid.UUID, state: str) -> None:
    """Sets a state as the database's administrator, past the lifecycle.

    The state's guard lets a change through only while soc.move_operation names the operation,
    so this names it for the transaction, as the move itself does.
    """
    async with admin.transaction():
        await admin.execute("select set_config('soc.moving_operation', $1, true)", str(operation))
        await admin.execute(FORCE, operation, state, END_REASON.get(state))


async def move(
    connection: asyncpg.Connection,
    operation: uuid.UUID,
    to_state: str,
    cause: str = "test",
    reason: str | None = None,
) -> None:
    await connection.execute(MOVE, operation, to_state, cause, reason)


async def state_of(connection: asyncpg.Connection, operation: uuid.UUID) -> str:
    state = await connection.fetchval(
        "select state::text from soc.operations where id = $1", operation
    )
    assert isinstance(state, str)
    return state


async def logged(connection: asyncpg.Connection, query: str, operation: uuid.UUID) -> list[Any]:
    rows = await connection.fetch(query, operation)
    return [json.loads(row["payload"]) for row in rows]


async def change_geofence_or_height(
    connection: asyncpg.Connection, operation: uuid.UUID, change: str, geofence: uuid.UUID
) -> None:
    if change == "geofence":
        await connection.execute(GEOFENCE_CHANGE, operation, geofence)
    else:
        await connection.execute(HEIGHT_CHANGE, operation)


async def assignment_change(
    admin: asyncpg.Connection, organization_id: uuid.UUID, change: str
) -> tuple[uuid.UUID, str, tuple[Any, ...]]:
    """An operation, and the editor's change to its assignment: the statement and its arguments."""
    flown = await Operations(admin).flown(organization_id)
    if change == "add":
        operation = await operation_in(admin, organization_id)
        return (
            operation,
            ADD_ASSIGNMENT,
            (operation, organization_id, flown.wayline_id, flown.fleet_id),
        )
    if change == "remove":
        await admin.execute("delete from soc.flights where id = $1", flown.flight_id)
        return (
            flown.operation_id,
            "delete from soc.assignments where id = $1",
            (flown.assignment_id,),
        )
    if change == "flight":
        return (
            flown.operation_id,
            "update soc.assignments set flight = $2::jsonb where id = $1",
            (flown.assignment_id, json.dumps({"segments": []})),
        )
    return (
        flown.operation_id,
        "update soc.assignments set speed_ms = 6 where id = $1",
        (flown.assignment_id,),
    )


async def edit_dependent(connection: asyncpg.Connection, what: str, flown: Flown) -> None:
    """An editor's change to the wayline, the geofence or the fleet an operation names."""
    if what == "fleet":
        model = await connection.fetchval(
            "select model from soc.aircraft_models where model <> (select model from soc.fleets"
            " where id = $1) order by model limit 1",
            flown.fleet_id,
        )
        await connection.execute(DEPENDENTS[what], flown.fleet_id, model)
    else:
        row_id = flown.wayline_id if what == "wayline" else flown.geofence_id
        await connection.execute(DEPENDENTS[what], row_id)


async def test_the_lifecycle_contract_is_the_lifecycle_the_database_enforces(
    admin: asyncpg.Connection,
) -> None:
    labels = await admin.fetchval(
        "select array_agg(enumlabel::text order by enumsortorder) from pg_enum"
        " where enumtypid = 'soc.operation_state'::regtype"
    )
    assert labels == STATES
    moves = await admin.fetch(
        "select from_state::text as source, to_state::text as target from soc.operation_moves"
    )
    assert len(moves) == len(CONTRACT["transitions"]) == len(MOVES)
    assert {(row["source"], row["target"]) for row in moves} == MOVES
    terminal = await admin.fetchval(
        "select array_agg(state::text order by state)"
        " from unnest(enum_range(null::soc.operation_state)) as state"
        " where soc.is_terminal(state)"
    )
    assert sorted(terminal) == sorted(CONTRACT["terminal"])


@pytest.mark.parametrize(
    ("before", "after"),
    [pytest.param(a, b, id=f"{a}-to-{b}") for a in STATES for b in STATES],
)
async def test_a_move_succeeds_exactly_where_the_lifecycle_lists_it(
    before: str, after: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    async with rolled_back(admin):
        operation = await operation_in(admin, organization)
        await force(admin, operation, before)
        if (before, after) in MOVES:
            await move(admin, operation, after, reason=END_REASON.get(after))
            assert await state_of(admin, operation) == after
        else:
            with pytest.raises(asyncpg.CheckViolationError) as refusal:
                async with admin.transaction():
                    await move(admin, operation, after)
            assert refusal.value.constraint_name == "operation_moves_by_the_lifecycle"
            assert await state_of(admin, operation) == before


async def test_every_move_writes_one_state_event_and_is_undone_with_its_transaction(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    operation = await operation_in(admin, organization)
    async with rolled_back(admin):
        await move(admin, operation, "planned", cause="plan")
        assert await logged(admin, STATE_EVENTS, operation) == [
            {"from": "draft", "to": "planned", "cause": "plan"}
        ]
    assert await logged(admin, STATE_EVENTS, operation) == []
    assert await state_of(admin, operation) == "draft"
    await move(admin, operation, "planned", cause="plan")
    await move(admin, operation, "preparing", cause="prepare")
    assert await logged(admin, STATE_EVENTS, operation) == [
        {"from": "draft", "to": "planned", "cause": "plan"},
        {"from": "planned", "to": "preparing", "cause": "prepare"},
    ]
    assert await state_of(admin, operation) == "preparing"


@pytest.mark.parametrize(
    ("source", "target", "reason"),
    [
        pytest.param("draft", "cancelled", None, id="cancelled"),
        pytest.param("returning", "completed", None, id="completed"),
        pytest.param("returning", "aborted", "operator_stop", id="aborted-with-a-reason"),
        pytest.param("returning", "failed", "link_lost", id="failed-with-a-reason"),
    ],
)
async def test_a_move_into_a_terminal_state_ends_the_record_with_its_reason(
    source: str, target: str, reason: str | None, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    async with rolled_back(admin):
        operation = await operation_in(admin, organization)
        await force(admin, operation, source)
        await move(admin, operation, target, reason=reason)
        row = await admin.fetchrow(
            "select state::text as state, end_reason::text as end_reason, ended_at,"
            " now() as moment from soc.operations where id = $1",
            operation,
        )
    assert row is not None
    assert (row["state"], row["end_reason"]) == (target, END_REASON[target])
    assert row["ended_at"] == row["moment"]


@pytest.mark.parametrize("target", ["aborted", "failed"])
async def test_an_abort_or_a_failure_without_a_reason_is_refused_by_name(
    target: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    async with rolled_back(admin):
        operation = await operation_in(admin, organization)
        await force(admin, operation, "returning")
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            async with admin.transaction():
                await move(admin, operation, target)
        assert refusal.value.constraint_name == "operation_ends_with_a_reason"


async def test_launching_sets_started_at_once_and_keeps_it(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    operation = await operation_in(admin, organization)
    await force(admin, operation, "ready")
    await move(admin, operation, "launching")
    first = await admin.fetchval("select started_at from soc.operations where id = $1", operation)
    assert first is not None
    await move(admin, operation, "ready")
    await move(admin, operation, "launching")
    again = await admin.fetchval("select started_at from soc.operations where id = $1", operation)
    assert again == first


@pytest.mark.parametrize("state", TERMINAL_STATES)
async def test_a_closed_operation_refuses_a_change_to_its_row_as_admin_and_as_editor(
    state: str, admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    await force(admin, operation, state)
    refusal = await refusal_of(
        admin.execute("update soc.operations set name = 'Renamed' where id = $1", operation)
    )
    assert refusal.constraint_name == "operation_closed"
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as as_editor:
            await connection.execute(HEIGHT_CHANGE, operation)
    assert as_editor.value.constraint_name == "operation_closed"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-10 names constraint operation_closed for any change to a closed operation; "
    "an assignment change is refused by operation_definition_frozen instead",
)
async def test_a_closed_operation_refuses_a_change_to_its_assignment_by_operation_closed(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    await force(admin, flown.operation_id, "completed")
    refusal = await refusal_of(
        admin.execute("update soc.assignments set speed_ms = 6 where id = $1", flown.assignment_id)
    )
    assert refusal.constraint_name == "operation_closed"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-10 names constraint operation_closed for any change to a closed operation; "
    "a new operator is refused by operation_definition_frozen instead",
)
async def test_a_closed_operation_refuses_a_new_operator_by_operation_closed(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await force(admin, flown.operation_id, "completed")
    refusal = await refusal_of(
        admin.execute(
            "insert into soc.operators (operation_id, organization_id, profile_id, role)"
            " values ($1, $2, $3, 'observer')",
            flown.operation_id,
            member.organization_id,
            member.user_id,
        )
    )
    assert refusal.constraint_name == "operation_closed"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-10: the record accepts no further change of any kind, enforced by the database. "
    "operation_changes guards only the operations row, so the log takes a new entry on a "
    "completed operation",
)
async def test_a_closed_operation_refuses_a_new_log_entry(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    await force(admin, flown.operation_id, "completed")
    await refusal_of(
        admin.fetchval("select soc.log_event($1, 'landed', 'aircraft')", flown.operation_id)
    )


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-10: the record accepts no further change of any kind, enforced by the database. "
    "record_checks writes a check on a completed operation",
)
async def test_a_closed_operation_refuses_new_check_results(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    await force(admin, flown.operation_id, "completed")
    judged = json.dumps(
        [
            {
                "check_id": "PF-LINK",
                "state": "pass",
                "blocking": True,
                "value": None,
                "detail": None,
                "evaluated_at": "2026-10-13T10:00:00Z",
            }
        ]
    )
    await refusal_of(
        admin.fetchval("select soc.record_checks($1, $2::jsonb)", flown.operation_id, judged)
    )


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-10: the record accepts no further change of any kind, enforced by the database. "
    "a flight can be added to a completed operation",
)
async def test_a_closed_operation_refuses_a_new_flight(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    await force(admin, flown.operation_id, "completed")
    await refusal_of(
        admin.execute(
            "insert into soc.flights (organization_id, operation_id, assignment_id, fleet_id,"
            " gateway_sn, aircraft_sn, mode, file_id, geofence_snapshot, envelope_snapshot)"
            " select organization_id, operation_id, assignment_id, fleet_id, gateway_sn,"
            " aircraft_sn, mode, file_id, geofence_snapshot, envelope_snapshot"
            " from soc.flights where id = $1",
            flown.flight_id,
        )
    )


async def test_an_editor_cannot_name_the_state_in_an_update(
    session: asyncpg.Connection, tenancy: Tenancy, admin: asyncpg.Connection
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(
                "update soc.operations set state = 'planned' where id = $1", operation
            )


async def test_soc_operations_cannot_update_an_operation_at_all(
    soc_operations: asyncpg.Connection, tenancy: Tenancy, admin: asyncpg.Connection
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_operations.execute(
            "update soc.operations set state = 'planned' where id = $1", operation
        )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_operations.execute(
            "update soc.operations set name = 'x' where id = $1", operation
        )


async def test_even_an_administrator_cannot_set_the_state_directly(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    async with rolled_back(admin):
        with pytest.raises(asyncpg.InsufficientPrivilegeError) as refusal:
            async with admin.transaction():
                await admin.execute(
                    "update soc.operations set state = 'planned' where id = $1", operation
                )
        assert "its state moves only by soc.move_operation" in refusal.value.message
        assert await state_of(admin, operation) == "draft"


async def test_a_new_operation_starts_as_a_draft_whatever_is_inserted(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    row = await admin.fetchrow(
        "insert into soc.operations"
        " (organization_id, name, state, end_reason, started_at, ended_at, created_at)"
        " values ($1, 'Norte', 'completed', 'completed', now(), now(), '2000-01-01')"
        " returning *",
        member.organization_id,
    )
    assert row is not None
    assert (row["state"], row["end_reason"], row["started_at"], row["ended_at"]) == (
        "draft",
        None,
        None,
        None,
    )
    assert row["created_at"] == row["updated_at"]
    assert row["created_by"] is None


async def test_the_member_who_inserts_an_operation_is_its_creator_and_the_log_says_so(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    async with acting_as(session, member.user_id) as connection:
        row = await connection.fetchrow(
            "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning *",
            member.organization_id,
        )
        assert row is not None
        logged_row = await connection.fetchrow(
            "select kind, source::text as source, actor_id, payload from soc.operation_events"
            " where operation_id = $1",
            row["id"],
        )
    assert row["created_by"] == member.user_id
    assert row["state"] == "draft"
    assert logged_row is not None
    assert (logged_row["kind"], logged_row["source"], logged_row["actor_id"]) == (
        "operation_created",
        "operator",
        member.user_id,
    )
    assert json.loads(logged_row["payload"]) == {"name": "Norte"}


@pytest.mark.parametrize("state", ACTIVE_STATES)
@pytest.mark.parametrize("change", ["geofence", "height"])
async def test_a_geofence_or_height_change_returns_the_operation_to_planned(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    first = await geofence_in(admin, member.organization_id)
    second = await geofence_in(admin, member.organization_id)
    operation = await operation_in(admin, member.organization_id, first)
    await force(admin, operation, state)
    async with acting_as(session, member.user_id) as connection:
        await change_geofence_or_height(connection, operation, change, second)
        assert await state_of(connection, operation) == "planned"
        assert (await logged(connection, DEFINITION_EVENTS, operation))[-1] == {"what": change}
        assert (await logged(connection, STATE_EVENTS, operation))[-1] == {
            "from": state,
            "to": "planned",
            "cause": f"{change}_changed",
        }


@pytest.mark.parametrize("state", PASSING_STATES)
@pytest.mark.parametrize("change", ["geofence", "height"])
async def test_a_geofence_or_height_change_in_draft_or_planned_moves_nothing(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    first = await geofence_in(admin, member.organization_id)
    second = await geofence_in(admin, member.organization_id)
    operation = await operation_in(admin, member.organization_id, first)
    await force(admin, operation, state)
    before = await logged(admin, STATE_EVENTS, operation)
    async with acting_as(session, member.user_id) as connection:
        await change_geofence_or_height(connection, operation, change, second)
        assert await state_of(connection, operation) == state
        assert (await logged(connection, DEFINITION_EVENTS, operation))[-1] == {"what": change}
    assert await logged(admin, STATE_EVENTS, operation) == before


@pytest.mark.parametrize("state", FROZEN_STATES)
@pytest.mark.parametrize("change", ["geofence", "height"])
async def test_a_geofence_or_height_change_is_refused_once_the_operation_flies_or_simulates(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    first = await geofence_in(admin, member.organization_id)
    second = await geofence_in(admin, member.organization_id)
    operation = await operation_in(admin, member.organization_id, first)
    await force(admin, operation, state)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            async with connection.transaction():
                await change_geofence_or_height(connection, operation, change, second)
        assert refusal.value.constraint_name == "operation_definition_frozen"
        assert await state_of(connection, operation) == state


@pytest.mark.parametrize("state", PASSING_STATES)
@pytest.mark.parametrize("change", ASSIGNMENT_CHANGES)
async def test_an_assignment_change_in_draft_or_planned_moves_nothing(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    operation, statement, arguments = await assignment_change(admin, member.organization_id, change)
    await force(admin, operation, state)
    async with acting_as(session, member.user_id) as connection:
        await connection.execute(statement, *arguments)
        assert await state_of(connection, operation) == state
        assert (await logged(connection, DEFINITION_EVENTS, operation))[-1] == {
            "what": "assignment"
        }


@pytest.mark.parametrize("state", FROZEN_STATES)
@pytest.mark.parametrize("change", ASSIGNMENT_CHANGES)
async def test_an_assignment_change_is_refused_once_the_operation_flies_or_simulates(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    operation, statement, arguments = await assignment_change(admin, member.organization_id, change)
    await force(admin, operation, state)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            async with connection.transaction():
                await connection.execute(statement, *arguments)
        assert refusal.value.constraint_name == "operation_definition_frozen"
        assert await state_of(connection, operation) == state


@pytest.mark.parametrize("state", ACTIVE_STATES)
@pytest.mark.parametrize("change", ASSIGNMENT_CHANGES)
async def test_an_assignment_change_returns_the_operation_to_planned(
    state: str,
    change: str,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    operation, statement, arguments = await assignment_change(admin, member.organization_id, change)
    await force(admin, operation, state)
    async with acting_as(session, member.user_id) as connection:
        await connection.execute(statement, *arguments)
        assert await state_of(connection, operation) == "planned"
        assert (await logged(connection, STATE_EVENTS, operation))[-1] == {
            "from": state,
            "to": "planned",
            "cause": "assignment_changed",
        }


@pytest.mark.parametrize("state", ACTIVE_STATES)
@pytest.mark.parametrize("what", ["wayline", "geofence", "fleet"])
async def test_an_edit_to_what_an_operation_names_returns_it_to_planned(
    state: str, what: str, admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await force(admin, flown.operation_id, state)
    async with acting_as(session, member.user_id) as connection:
        await edit_dependent(connection, what, flown)
        assert await state_of(connection, flown.operation_id) == "planned"
        assert (await logged(connection, STATE_EVENTS, flown.operation_id))[-1] == {
            "from": state,
            "to": "planned",
            "cause": f"{what}_changed",
        }


@pytest.mark.parametrize("state", [*PASSING_STATES, "in_flight", "paused", "returning"])
@pytest.mark.parametrize("what", ["wayline", "geofence", "fleet"])
async def test_an_edit_to_what_an_operation_names_leaves_it_where_it_is(
    state: str, what: str, admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await force(admin, flown.operation_id, state)
    async with acting_as(session, member.user_id) as connection:
        await edit_dependent(connection, what, flown)
        assert await state_of(connection, flown.operation_id) == state


@pytest.mark.parametrize("state", ["simulating", "launching"])
@pytest.mark.parametrize("what", ["wayline", "geofence", "fleet"])
@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="FR-OPS-07: a change to the wayline, the geofence or the fleet returns the operation "
    "to planned. The lifecycle has no move from simulating or launching to planned, and the "
    "trigger that moves dependents skips both states without a word, so the operation keeps the "
    "file it was built from",
)
async def test_an_edit_to_what_a_simulating_or_launching_operation_names_returns_it_to_planned(
    state: str, what: str, admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await force(admin, flown.operation_id, state)
    async with acting_as(session, member.user_id) as connection:
        await edit_dependent(connection, what, flown)
        assert await state_of(connection, flown.operation_id) == "planned"


async def test_a_second_assignment_is_refused_in_the_mvp(
    admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            await connection.execute(
                ADD_ASSIGNMENT,
                flown.operation_id,
                member.organization_id,
                flown.wayline_id,
                flown.fleet_id,
            )
    assert refusal.value.constraint_name == "assignment_one_in_mvp"


@pytest.mark.parametrize(
    ("duplicate", "named"),
    [("wayline", "assignment_wayline_once"), ("fleet", "assignment_fleet_once")],
)
async def test_a_wayline_or_a_fleet_appears_once_per_operation(
    duplicate: str, named: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    other = await Operations(admin).flown(member.organization_id)
    wayline, fleet = (
        (flown.wayline_id, other.fleet_id)
        if duplicate == "wayline"
        else (other.wayline_id, flown.fleet_id)
    )
    async with rolled_back(admin):
        await admin.execute("alter table soc.assignments disable trigger assignment_changes")
        with pytest.raises(asyncpg.UniqueViolationError) as refusal:
            async with admin.transaction():
                await admin.execute(
                    ADD_ASSIGNMENT, flown.operation_id, member.organization_id, wayline, fleet
                )
        assert refusal.value.constraint_name == named


async def test_the_one_per_operation_constraints_exist_under_their_names(
    admin: asyncpg.Connection,
) -> None:
    rows = await admin.fetch(
        "select conname, contype::text as kind from pg_constraint"
        " where conrelid = 'soc.assignments'::regclass"
        " and conname in ('assignment_wayline_once', 'assignment_fleet_once')"
    )
    assert {row["conname"]: row["kind"] for row in rows} == {
        "assignment_wayline_once": "u",
        "assignment_fleet_once": "u",
    }


@pytest.mark.parametrize("speed", [0, -1])
async def test_a_non_positive_assignment_speed_is_refused_by_name(
    speed: int, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    flown = await Operations(admin).flown(organization)
    operation = await operation_in(admin, organization)
    refusal = await refusal_of(
        admin.execute(
            "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id,"
            " speed_ms) values ($1, $2, $3, $4, $5)",
            operation,
            organization,
            flown.wayline_id,
            flown.fleet_id,
            speed,
        )
    )
    assert isinstance(refusal, asyncpg.CheckViolationError)
    assert refusal.constraint_name == "assignment_speed_positive"


@pytest.mark.parametrize("height", [0, -5])
async def test_a_non_positive_takeoff_height_is_refused_by_name(
    height: int, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await admin.execute(
            "insert into soc.operations (organization_id, name, takeoff_security_height_m)"
            " values ($1, 'Norte', $2)",
            organization,
            height,
        )
    assert refusal.value.constraint_name == "operation_height_positive"


async def test_an_editor_sets_the_flight_of_an_assignment(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        kept = await connection.fetchval(
            "update soc.assignments set flight = $2::jsonb where id = $1 returning flight",
            flown.assignment_id,
            json.dumps({"segments": [{"speed_ms": 5}]}),
        )
    assert json.loads(kept) == {"segments": [{"speed_ms": 5}]}


async def test_an_assignment_flight_is_an_object_when_present(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member()).organization_id
    flown = await Operations(admin).flown(organization)
    operation = await operation_in(admin, organization)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await admin.execute(
            "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id,"
            " flight) values ($1, $2, $3, $4, '[]'::jsonb)",
            operation,
            organization,
            flown.wayline_id,
            flown.fleet_id,
        )
    assert refusal.value.constraint_name == "assignment_flight_object"
    kept = await admin.fetchval(
        "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id, flight)"
        " values ($1, $2, $3, $4, null) returning flight",
        operation,
        organization,
        flown.wayline_id,
        flown.fleet_id,
    )
    assert kept is None


@pytest.mark.parametrize(
    ("named", "constraint"),
    [
        ("wayline", "assignments_wayline_id_organization_id_fkey"),
        ("fleet", "assignments_fleet_id_organization_id_fkey"),
    ],
)
async def test_an_assignment_naming_another_organizations_wayline_or_fleet_is_refused(
    named: str, constraint: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    mine = (await tenancy.member()).organization_id
    theirs = await Operations(admin).flown((await tenancy.member()).organization_id)
    mine_flown = await Operations(admin).flown(mine)
    operation = await operation_in(admin, mine)
    wayline = theirs.wayline_id if named == "wayline" else mine_flown.wayline_id
    fleet = theirs.fleet_id if named == "fleet" else mine_flown.fleet_id
    with pytest.raises(asyncpg.ForeignKeyViolationError) as refusal:
        await admin.execute(
            "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id,"
            " speed_ms) values ($1, $2, $3, $4, 5)",
            operation,
            mine,
            wayline,
            fleet,
        )
    assert refusal.value.constraint_name == constraint


async def test_an_operator_must_be_a_member_of_the_operations_organization(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    mine = await tenancy.member("editor")
    outsider = await tenancy.member("editor")
    operation = await operation_in(admin, mine.organization_id)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as refusal:
        await admin.execute(
            "insert into soc.operators (operation_id, organization_id, profile_id, role)"
            " values ($1, $2, $3, 'pilot')",
            operation,
            mine.organization_id,
            outsider.user_id,
        )
    assert refusal.value.constraint_name == "operators_organization_id_profile_id_fkey"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="README rule: membership is read through the soc.* helpers, never through a foreign "
    "key, because soft-deleted memberships stay in the table. soc.operators references "
    "public.memberships by key, so a retired member can still be named a pilot",
)
async def test_a_retired_membership_cannot_be_named_an_operator(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    await tenancy.soft_delete_membership(member)
    await refusal_of(
        admin.execute(
            "insert into soc.operators (operation_id, organization_id, profile_id, role)"
            " values ($1, $2, $3, 'pilot')",
            operation,
            member.organization_id,
            member.user_id,
        )
    )


@pytest.mark.parametrize(
    "state", ["launching", "in_flight", "paused", "returning", *TERMINAL_STATES]
)
async def test_operators_are_fixed_from_launching_on(
    state: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    await force(admin, operation, state)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await admin.execute(
            "insert into soc.operators (operation_id, organization_id, profile_id, role)"
            " values ($1, $2, $3, 'observer')",
            operation,
            member.organization_id,
            member.user_id,
        )
    assert refusal.value.constraint_name == "operation_definition_frozen"


@pytest.mark.parametrize("state", [*PASSING_STATES, *ACTIVE_STATES, "simulating"])
async def test_operators_may_change_until_the_operation_launches(
    state: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    await force(admin, operation, state)
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, 'pilot')",
        operation,
        member.organization_id,
        member.user_id,
    )
    role = await admin.fetchval(
        "select role::text from soc.operators where operation_id = $1 and profile_id = $2",
        operation,
        member.user_id,
    )
    assert role == "pilot"


@pytest.mark.xfail(
    strict=True,
    raises=asyncpg.CheckViolationError,
    reason="README rule: Virtual Origen deletes users by cascade and SOC must not block it. The "
    "key sets created_by to null, but operation_changes refuses any change to a closed operation "
    "(operation_closed), so a user who made a closed operation cannot be deleted",
)
async def test_deleting_a_user_who_made_a_closed_operation_is_not_blocked(
    admin: asyncpg.Connection, session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    creator = await tenancy.member("editor")
    async with impersonate_committed(session, creator.user_id):
        await session.execute(
            "insert into soc.operations (organization_id, name) values ($1, 'Norte')",
            creator.organization_id,
        )
    operation = await admin.fetchval(
        "select id from soc.operations where created_by = $1", creator.user_id
    )
    assert isinstance(operation, uuid.UUID)
    await force(admin, operation, "cancelled")
    await admin.execute("delete from auth.users where id = $1", creator.user_id)


@asynccontextmanager
async def impersonate_committed(
    session: asyncpg.Connection, user: uuid.UUID
) -> AsyncIterator[asyncpg.Connection]:
    """Acts as the user and keeps what was done, as a request through PostgREST does."""
    async with session.transaction():
        await impersonate(session, user)
        yield session


@pytest.mark.xfail(
    strict=True,
    raises=asyncpg.ForeignKeyViolationError,
    reason="README rule: Virtual Origen deletes organizations by cascade and SOC must not block "
    "it. soc.operations, soc.flight_files and soc.operation_events reference public.organizations "
    "without cascade (0004, 0007 and 0008 cascade), and the log cannot follow a cascade: its rows "
    "are append-only",
)
async def test_deleting_an_organization_takes_its_operations_and_their_log(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    await operation_in(admin, owner.organization_id)
    await admin.execute("delete from public.organizations where id = $1", owner.organization_id)
    remaining = await admin.fetchval(
        "select count(*) from soc.operations where organization_id = $1", owner.organization_id
    )
    assert remaining == 0


async def test_an_operation_that_has_flown_is_never_deleted(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member()).organization_id)
    refusal = await refusal_of(
        admin.execute("delete from soc.operations where id = $1", flown.operation_id)
    )
    assert isinstance(refusal, asyncpg.ForeignKeyViolationError)
