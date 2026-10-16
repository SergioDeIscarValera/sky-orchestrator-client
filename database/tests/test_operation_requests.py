from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import pytest

from soc_database.harness import (
    EphemeralPostgres,
    Flown,
    Member,
    Operations,
    Tenancy,
    acting_as,
    impersonate,
)

GATEWAY = "SOTESTDOCK01"
TO_COMPLETED = [
    "planned",
    "preparing",
    "simulating",
    "simulated",
    "ready",
    "launching",
    "in_flight",
    "returning",
    "completed",
]
STATUSES = ["pending", "running", "accepted", "refused", "failed", "expired"]
FORWARD = {
    ("pending", "running"),
    ("pending", "expired"),
    ("running", "accepted"),
    ("running", "refused"),
    ("running", "failed"),
}
# Sets a request's status with the decision's own columns, so the check constraints hold.
PUT_STATUS = """
update soc.transition_requests
   set status = $2::text::soc.request_status,
       decided_at = case when $2::text in ('accepted', 'refused', 'failed', 'expired')
                         then now() end,
       reasons = case when $2::text in ('refused', 'failed') then '[]'::jsonb end
 where id = $1
"""
DISABLE_GUARD = (
    "alter table soc.transition_requests disable trigger transition_request_moves_forward"
)
ENABLE_GUARD = "alter table soc.transition_requests enable trigger transition_request_moves_forward"
TRANSITION_REQUEST = (
    "insert into soc.transition_requests (client_request_id, organization_id, operation_id,"
    " transition, requested_at) values ($1, $2, $3, 'plan', coalesce($4, now())) returning *"
)
COMMAND_INTENT = (
    "insert into soc.command_intents (client_request_id, organization_id, operation_id, flight_id,"
    " gateway_sn, verb, payload, requested_by, requested_at)"
    " values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, coalesce($9, now())) returning *"
)
CLAIM_REQUEST = "select * from soc.claim_transition_request($1, 60)"
ASK = "select * from soc.request_transition($1, $2::soc.transition, $3, '{}'::jsonb)"
COMMAND = "select * from soc.request_command($1, $2::soc.command_verb, $3, '{}'::jsonb)"


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


@asynccontextmanager
async def rolled_back(connection: asyncpg.Connection) -> AsyncIterator[asyncpg.Connection]:
    """Everything done inside the block is undone when it ends."""
    transaction = connection.transaction()
    await transaction.start()
    try:
        yield connection
    finally:
        await transaction.rollback()


@asynccontextmanager
async def listening(migrated: EphemeralPostgres, channel: str) -> AsyncIterator[asyncio.Queue[str]]:
    """The payloads of the channel's notifications, in the order the database delivers them."""
    heard: asyncio.Queue[str] = asyncio.Queue()
    listener = await migrated.connect()
    try:
        await listener.add_listener(channel, lambda *arguments: heard.put_nowait(arguments[3]))
        yield heard
    finally:
        await listener.close()


async def operation_of(admin: asyncpg.Connection, organization_id: uuid.UUID) -> uuid.UUID:
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning id",
        organization_id,
    )
    assert isinstance(operation, uuid.UUID)
    return operation


async def ask(
    connection: asyncpg.Connection,
    operation: uuid.UUID,
    wanted: str,
    client_request: uuid.UUID | None = None,
) -> asyncpg.Record:
    row = await connection.fetchrow(ASK, operation, wanted, client_request or uuid.uuid4())
    assert row is not None
    return row


async def request_in(
    admin: asyncpg.Connection, organization_id: uuid.UUID, operation: uuid.UUID, when: Any = None
) -> asyncpg.Record:
    """A pending request made by the administrator, optionally dated."""
    row = await admin.fetchrow(TRANSITION_REQUEST, uuid.uuid4(), organization_id, operation, when)
    assert row is not None
    return row


async def add_operator(
    admin: asyncpg.Connection, member: Member, operation: uuid.UUID, role: str
) -> None:
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, $4::soc.operator_role)",
        operation,
        member.organization_id,
        member.user_id,
        role,
    )


async def viewer_in(tenancy: Tenancy, organization_id: uuid.UUID) -> Member:
    viewer = Member(await tenancy.user(), organization_id)
    await tenancy.join(viewer.user_id, organization_id, "viewer")
    return viewer


async def pilot_of(admin: asyncpg.Connection, tenancy: Tenancy) -> tuple[Member, Flown]:
    """An editor who is the pilot of an operation with one flight, and that flight."""
    member = await tenancy.member("editor")
    flown = await Operations(admin).flown(member.organization_id)
    await add_operator(admin, member, flown.operation_id, "pilot")
    return member, flown


async def command(
    connection: asyncpg.Connection,
    flight: uuid.UUID,
    verb: str,
    client_request: uuid.UUID | None = None,
) -> asyncpg.Record:
    row = await connection.fetchrow(COMMAND, flight, verb, client_request or uuid.uuid4())
    assert row is not None
    return row


async def intent_in(
    admin: asyncpg.Connection,
    member: Member,
    flown: Flown,
    verb: str,
    requested_at: Any = None,
    requested_by: uuid.UUID | None = None,
) -> uuid.UUID:
    row = await admin.fetchrow(
        COMMAND_INTENT,
        uuid.uuid4(),
        member.organization_id,
        flown.operation_id,
        flown.flight_id,
        GATEWAY,
        verb,
        "{}",
        requested_by,
        requested_at,
    )
    assert row is not None
    intent = row["id"]
    assert isinstance(intent, uuid.UUID)
    return intent


async def test_an_editor_asks_a_move_and_the_ask_is_pending_and_logged(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        asked = await ask(connection, operation, "plan")
        logged = await connection.fetchrow(
            "select source::text as source, actor_id, payload from soc.operation_events"
            " where operation_id = $1 and kind = 'transition_requested'",
            operation,
        )
    assert (asked["status"], asked["requested_by"], asked["transition"]) == (
        "pending",
        member.user_id,
        "plan",
    )
    assert (asked["decided_at"], asked["reasons"]) == (None, None)
    assert logged is not None
    assert (logged["source"], logged["actor_id"]) == ("operator", member.user_id)
    assert json.loads(logged["payload"]) == {"transition": "plan", "request": str(asked["id"])}


async def test_a_request_is_announced_only_once_it_commits(
    session: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with listening(migrated, "soc_transition_requests") as heard:
        async with acting_as(session, member.user_id) as connection:
            await ask(connection, operation, "plan")
        async with committed_as(session, member.user_id) as connection:
            committed = await ask(connection, operation, "plan")
        assert await asyncio.wait_for(heard.get(), 5) == str(committed["id"])
        assert heard.empty()


@pytest.mark.parametrize("actor", ["viewer", "editor-of-another-organization", "non-member"])
async def test_a_viewer_a_member_of_another_organization_and_a_non_member_cannot_ask(
    actor: str, session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    operation = await operation_of(admin, owner.organization_id)
    if actor == "viewer":
        user_id = (await viewer_in(tenancy, owner.organization_id)).user_id
    elif actor == "editor-of-another-organization":
        user_id = (await tenancy.member("editor")).user_id
    else:
        user_id = await tenancy.user()
    async with acting_as(session, user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await ask(connection, operation, "plan")


@pytest.mark.parametrize(
    ("wanted", "member_role", "operator_role", "accepted"),
    [
        pytest.param("simulate", "editor", "observer", False, id="simulate-as-observer"),
        pytest.param("simulate", "editor", "pilot", True, id="simulate-as-pilot"),
        pytest.param("launch", "editor", "observer", False, id="launch-as-observer"),
        pytest.param("launch", "editor", "pilot", True, id="launch-as-pilot"),
        pytest.param("stop", "editor", "observer", False, id="stop-as-observer"),
        pytest.param("stop", "editor", "pilot", True, id="stop-as-pilot"),
        pytest.param("simulate", "viewer", "pilot", False, id="simulate-as-viewer-pilot"),
        pytest.param("plan", "editor", None, True, id="plan-needs-no-pilot"),
        pytest.param("cancel", "editor", "observer", True, id="cancel-as-observer"),
    ],
)
async def test_simulate_launch_and_stop_need_a_pilot_who_is_an_editor(
    wanted: str,
    member_role: str,
    operator_role: str | None,
    accepted: bool,
    session: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    owner = await tenancy.member("owner")
    operation = await operation_of(admin, owner.organization_id)
    actor = Member(await tenancy.user(), owner.organization_id)
    await tenancy.join(actor.user_id, owner.organization_id, member_role)
    if operator_role is not None:
        await add_operator(admin, actor, operation, operator_role)
    async with acting_as(session, actor.user_id) as connection:
        if accepted:
            asked = await ask(connection, operation, wanted)
            assert asked["status"] == "pending"
        else:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await ask(connection, operation, wanted)


async def test_the_same_client_request_gives_back_the_same_request(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    key = uuid.uuid4()
    async with acting_as(session, member.user_id) as connection:
        first = await ask(connection, operation, "plan", key)
        second = await ask(connection, operation, "plan", key)
        requested = await connection.fetchval(
            "select count(*) from soc.operation_events where operation_id = $1"
            " and kind = 'transition_requested'",
            operation,
        )
    assert second["id"] == first["id"]
    assert requested == 1


async def test_a_request_is_claimed_once(
    session: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    soc_operations: asyncpg.Connection,
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with committed_as(session, member.user_id) as connection:
        asked = await ask(connection, operation, "plan")
    claimed = await soc_operations.fetch(CLAIM_REQUEST, asked["id"])
    again = await soc_operations.fetch(CLAIM_REQUEST, asked["id"])
    assert [row["status"] for row in claimed] == ["running"]
    assert again == []


async def test_a_request_older_than_its_ttl_expires_instead_of_running(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_operations: asyncpg.Connection
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    an_hour_ago = await admin.fetchval("select now() - interval '1 hour'")
    late = await request_in(admin, member.organization_id, operation, an_hour_ago)
    claimed = await soc_operations.fetch(CLAIM_REQUEST, late["id"])
    assert [(row["status"], row["decided_at"] is not None) for row in claimed] == [
        ("expired", True)
    ]


@pytest.mark.parametrize(
    ("outcome", "severity"),
    [("refused", "warning"), ("failed", "error")],
)
async def test_a_decision_records_its_reasons_and_logs_the_refusal(
    outcome: str,
    severity: str,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    soc_operations: asyncpg.Connection,
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    asked = await request_in(admin, member.organization_id, operation)
    await soc_operations.fetch(CLAIM_REQUEST, asked["id"])
    reasons = [{"check": "PF-LINK", "detail": "the stack is unreachable"}]
    decided = await soc_operations.fetch(
        "select * from soc.decide_transition_request($1, $2::soc.request_status, $3::jsonb)",
        asked["id"],
        outcome,
        json.dumps(reasons),
    )
    assert [(row["status"], json.loads(row["reasons"])) for row in decided] == [(outcome, reasons)]
    logged = await admin.fetchrow(
        "select severity::text as severity, source::text as source, payload"
        " from soc.operation_events where operation_id = $1 and kind = 'transition_refused'",
        operation,
    )
    assert logged is not None
    assert (logged["severity"], logged["source"]) == (severity, "soc-operations")
    assert json.loads(logged["payload"]) == {
        "transition": "plan",
        "request": str(asked["id"]),
        "reasons": reasons,
    }


async def test_a_request_that_is_not_running_is_not_decided(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_operations: asyncpg.Connection
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    asked = await request_in(admin, member.organization_id, operation)
    decided = await soc_operations.fetch(
        "select * from soc.decide_transition_request($1, 'accepted', null)", asked["id"]
    )
    assert decided == []


async def force_request(admin: asyncpg.Connection, request: uuid.UUID, status: str) -> None:
    """Sets a request's status past its guard; the caller's transaction undoes it."""
    await admin.execute(DISABLE_GUARD)
    await admin.execute(PUT_STATUS, request, status)
    await admin.execute(ENABLE_GUARD)


ALLOWED = [
    pytest.param(before, after, id=f"{before}-to-{after}") for before, after in sorted(FORWARD)
]
REFUSED = [
    pytest.param(before, after, id=f"{before}-to-{after}")
    for before in STATUSES
    for after in STATUSES
    if before != after and (before, after) not in FORWARD
]


@pytest.mark.parametrize(("before", "after"), ALLOWED)
async def test_a_request_moves_forward_along_the_listed_moves(
    before: str, after: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with rolled_back(admin):
        asked = await request_in(admin, member.organization_id, operation)
        await force_request(admin, asked["id"], before)
        await admin.execute(PUT_STATUS, asked["id"], after)
        status = await admin.fetchval(
            "select status::text from soc.transition_requests where id = $1", asked["id"]
        )
    assert status == after


@pytest.mark.parametrize(("before", "after"), REFUSED)
async def test_a_request_never_moves_backwards_or_sideways(
    before: str, after: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with rolled_back(admin):
        asked = await request_in(admin, member.organization_id, operation)
        await force_request(admin, asked["id"], before)
        with pytest.raises(asyncpg.CheckViolationError, match="cannot become"):
            await admin.execute(PUT_STATUS, asked["id"], after)


@pytest.mark.parametrize(
    "change",
    [
        "update soc.transition_requests set transition = 'stop' where id = $1",
        "update soc.transition_requests set requested_at = now() - interval '1 hour' where id = $1",
        "update soc.transition_requests set request_meta = '{\"changed\": true}' where id = $1",
        "update soc.transition_requests set client_request_id = gen_random_uuid() where id = $1",
    ],
)
async def test_what_was_asked_never_changes(
    change: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    asked = await request_in(admin, member.organization_id, operation)
    with pytest.raises(asyncpg.CheckViolationError, match="never changes"):
        await admin.execute(change, asked["id"])


async def test_every_change_to_a_request_is_broadcast_on_the_state_topic(
    todays_partition: None,
    session: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    soc_operations: asyncpg.Connection,
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    async with committed_as(session, member.user_id) as connection:
        asked = await ask(connection, operation, "plan")
    await soc_operations.fetch(CLAIM_REQUEST, asked["id"])
    rows = await admin.fetch(
        "select event, private, payload from realtime.messages"
        " where topic = $1 and event = 'transition_request' order by inserted_at, id",
        f"org:{member.organization_id}:soc:state",
    )
    payloads = [json.loads(row["payload"]) for row in rows]
    assert [payload["status"] for payload in payloads if payload["id"] == str(asked["id"])] == [
        "pending",
        "running",
    ]
    assert all(row["private"] for row in rows)


@pytest.mark.parametrize(
    ("verb", "undo"),
    [
        pytest.param("pause", False, id="pause"),
        pytest.param("recovery", False, id="recovery"),
        pytest.param("return_home", False, id="return-home"),
        pytest.param("undo", True, id="undo"),
    ],
)
async def test_a_pilot_asks_each_command_and_it_is_pending_with_its_payload(
    verb: str, undo: bool, session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    expected = {"flight_ids": [str(flown.flight_id)]} if undo else {}
    async with acting_as(session, member.user_id) as connection:
        asked = await command(connection, flown.flight_id, verb)
        logged = await connection.fetchrow(
            "select source::text as source, actor_id, flight_id, fleet_id, payload"
            " from soc.operation_events where command_id = $1 and kind = 'command_requested'",
            asked["id"],
        )
    assert (asked["status"], asked["verb"], asked["requested_by"]) == (
        "pending",
        verb,
        member.user_id,
    )
    assert json.loads(asked["payload"]) == expected
    assert (asked["gateway_sn"], asked["flight_id"]) == (flown.gateway_sn, flown.flight_id)
    assert logged is not None
    assert (logged["source"], logged["actor_id"], logged["flight_id"], logged["fleet_id"]) == (
        "operator",
        member.user_id,
        flown.flight_id,
        flown.fleet_id,
    )
    assert json.loads(logged["payload"]) == {"verb": verb}


async def test_the_same_client_request_gives_back_the_same_command_and_one_entry(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    key = uuid.uuid4()
    async with acting_as(session, member.user_id) as connection:
        first = await command(connection, flown.flight_id, "pause", key)
        second = await command(connection, flown.flight_id, "pause", key)
        entries = await connection.fetchval(
            "select count(*) from soc.operation_events where command_id = $1", first["id"]
        )
    assert second["id"] == first["id"]
    assert entries == 1


@pytest.mark.parametrize("verb", ["prepare", "execute"])
async def test_a_pilot_asks_only_pause_recovery_return_home_or_undo(
    verb: str, session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InvalidParameterValueError):
            await command(connection, flown.flight_id, verb)


@pytest.mark.parametrize("actor", ["observer", "viewer-pilot", "stranger"])
async def test_only_a_pilot_who_is_an_editor_commands_a_flight(
    actor: str, session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    pilot, flown = await pilot_of(admin, tenancy)
    if actor == "stranger":
        user_id = (await tenancy.member("editor")).user_id
    else:
        role = "editor" if actor == "observer" else "viewer"
        user = Member(await tenancy.user(), pilot.organization_id)
        await tenancy.join(user.user_id, pilot.organization_id, role)
        await add_operator(
            admin, user, flown.operation_id, "observer" if actor == "observer" else "pilot"
        )
        user_id = user.user_id
    async with acting_as(session, user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await command(connection, flown.flight_id, "pause")


async def test_a_flight_that_has_ended_takes_no_command(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    await admin.execute(
        "update soc.flights set ended_at = now(), end_reason = 'operator_return' where id = $1",
        flown.flight_id,
    )
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            await command(connection, flown.flight_id, "pause")
    assert refusal.value.constraint_name == "command_flight_ended"


async def test_an_undo_cancels_only_a_flight_not_executing_yet(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    await admin.execute("update soc.flights set executed_at = now() where id = $1", flown.flight_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            await command(connection, flown.flight_id, "undo")
    async with acting_as(session, member.user_id) as connection:
        paused = await command(connection, flown.flight_id, "pause")
    assert refusal.value.constraint_name == "command_undo_before_execution"
    assert paused["status"] == "pending"


async def test_a_command_naming_no_operation_is_refused_by_its_key(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as refusal:
        await admin.execute(
            COMMAND_INTENT,
            uuid.uuid4(),
            member.organization_id,
            uuid.uuid4(),
            flown.flight_id,
            GATEWAY,
            "pause",
            "{}",
            None,
            None,
        )
    assert refusal.value.constraint_name == "command_intent_operation"


async def test_a_command_naming_no_flight_is_refused_by_its_key(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as refusal:
        await admin.execute(
            COMMAND_INTENT,
            uuid.uuid4(),
            member.organization_id,
            flown.operation_id,
            uuid.uuid4(),
            GATEWAY,
            "pause",
            "{}",
            None,
            None,
        )
    assert refusal.value.constraint_name == "command_intent_flight"


async def test_every_command_is_logged_once_whoever_asks_it(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    async with acting_as(session, member.user_id) as connection:
        asked = await command(connection, flown.flight_id, "pause")
        by_pilot = await connection.fetch(
            "select source::text as source, actor_id from soc.operation_events"
            " where command_id = $1 and kind = 'command_requested'",
            asked["id"],
        )
    service_intent = await intent_in(admin, member, flown, "return_home")
    by_service = await admin.fetch(
        "select source::text as source, actor_id from soc.operation_events where command_id = $1"
        " and kind = 'command_requested'",
        service_intent,
    )
    assert [(row["source"], row["actor_id"]) for row in by_pilot] == [("operator", member.user_id)]
    assert [(row["source"], row["actor_id"]) for row in by_service] == [("soc-operations", None)]


async def test_a_settled_command_is_logged_with_its_outcome_and_announced(
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    soc_cloud: asyncpg.Connection,
    migrated: EphemeralPostgres,
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    accepted = await intent_in(admin, member, flown, "return_home")
    failed = await intent_in(admin, member, flown, "pause")
    async with listening(migrated, "soc_command_outcomes") as heard:
        await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", accepted)
        sent_outcomes = await admin.fetchval(
            "select count(*) from soc.operation_events where command_id = $1"
            " and kind = 'command_outcome'",
            accepted,
        )
        assert sent_outcomes == 0
        await soc_cloud.fetch("select * from soc.record_command_reply($1, 0)", accepted)
        await soc_cloud.fetch("select * from soc.fail_command_intent($1)", failed)
        assert await asyncio.wait_for(heard.get(), 5) == str(accepted)
        assert await asyncio.wait_for(heard.get(), 5) == str(failed)
        assert heard.empty()
    outcomes = await admin.fetch(
        "select command_id, severity::text as severity, payload from soc.operation_events"
        " where kind = 'command_outcome' and command_id = any($1::uuid[]) order by recorded_at",
        [accepted, failed],
    )
    by_intent = {
        row["command_id"]: (row["severity"], json.loads(row["payload"])) for row in outcomes
    }
    assert by_intent[accepted] == (
        "info",
        {"verb": "return_home", "status": "accepted", "result": 0},
    )
    assert by_intent[failed] == ("warning", {"verb": "pause", "status": "failed", "result": None})


@pytest.mark.parametrize(
    ("path", "status"),
    [
        pytest.param("refused", "refused", id="refused"),
        pytest.param("timed_out", "timed_out", id="timed-out"),
        pytest.param("expired", "expired", id="expired"),
    ],
)
async def test_an_unaccepted_command_is_logged_as_a_warning_with_its_status(
    path: str,
    status: str,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    soc_cloud: asyncpg.Connection,
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    if path == "expired":
        an_hour_ago = await admin.fetchval("select now() - interval '1 hour'")
        intent = await intent_in(admin, member, flown, "pause", an_hour_ago)
    else:
        intent = await intent_in(admin, member, flown, "pause")
    await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    if path == "refused":
        await soc_cloud.fetch("select * from soc.record_command_reply($1, 314010)", intent)
    elif path == "timed_out":
        await soc_cloud.fetch("select * from soc.time_out_command_intent($1)", intent)
    logged = await admin.fetchrow(
        "select severity::text as severity, payload from soc.operation_events"
        " where command_id = $1 and kind = 'command_outcome'",
        intent,
    )
    assert logged is not None
    assert logged["severity"] == "warning"
    assert json.loads(logged["payload"])["status"] == status


async def test_a_refused_command_is_logged_as_a_warning_by_design(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_cloud: asyncpg.Connection
) -> None:
    """A writer may raise an entry above its kind's severity: a refused command is a warning."""
    member, flown = await pilot_of(admin, tenancy)
    intent = await intent_in(admin, member, flown, "pause")
    await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    await soc_cloud.fetch("select * from soc.record_command_reply($1, 314010)", intent)
    severity = await admin.fetchval(
        "select severity::text from soc.operation_events where command_id = $1"
        " and kind = 'command_outcome'",
        intent,
    )
    assert severity == "warning"


async def test_a_command_claimed_for_sending_is_not_yet_an_outcome(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_cloud: asyncpg.Connection
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    intent = await intent_in(admin, member, flown, "pause")
    claimed = await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    assert [row["status"] for row in claimed] == ["sent"]
    outcomes = await admin.fetchval(
        "select count(*) from soc.operation_events where command_id = $1"
        " and kind = 'command_outcome'",
        intent,
    )
    assert outcomes == 0


async def test_a_closed_operation_takes_no_transition_request(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    await Operations(admin).move(operation, "planned", "cancelled")
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.CheckViolationError) as refusal:
            await ask(connection, operation, "plan")
    assert refusal.value.constraint_name == "operation_closed"


async def test_a_refusal_of_a_closed_operation_is_decided_but_not_logged(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_operations: asyncpg.Connection
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    asked = await request_in(admin, member.organization_id, operation)
    await soc_operations.fetch(CLAIM_REQUEST, asked["id"])
    await Operations(admin).move(operation, *TO_COMPLETED)
    decided = await soc_operations.fetch(
        "select * from soc.decide_transition_request($1, 'refused', $2::jsonb)",
        asked["id"],
        json.dumps([{"check": "PF-LINK"}]),
    )
    assert [row["status"] for row in decided] == ["refused"]
    refusals = await admin.fetchval(
        "select count(*) from soc.operation_events where operation_id = $1"
        " and kind = 'transition_refused'",
        operation,
    )
    assert refusals == 0


async def test_a_command_on_a_closed_operation_is_kept_and_not_logged(
    admin: asyncpg.Connection, tenancy: Tenancy, soc_cloud: asyncpg.Connection
) -> None:
    member, flown = await pilot_of(admin, tenancy)
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    intent = await intent_in(admin, member, flown, "pause")
    await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    await soc_cloud.fetch("select * from soc.record_command_reply($1, 0)", intent)
    kept = await admin.fetchval(
        "select status::text from soc.command_intents where id = $1", intent
    )
    assert kept == "accepted"
    logged = await admin.fetchval(
        "select count(*) from soc.operation_events where command_id = $1", intent
    )
    assert logged == 0
