from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as

EVENTS = Path(__file__).resolve().parents[2] / "contracts" / "events" / "events.json"
CONTRACT: dict[str, Any] = json.loads(EVENTS.read_text(encoding="utf-8"))
SEVERITY_OF: dict[str, str] = {kind: spec["severity"] for kind, spec in CONTRACT["kinds"].items()}
ENTRY_COLUMNS = frozenset(
    {
        "id",
        "organization_id",
        "operation_id",
        "flight_id",
        "fleet_id",
        "command_id",
        "occurred_at",
        "recorded_at",
        "kind",
        "severity",
        "source",
        "actor_id",
        "payload",
    }
)
UPDATE = "update soc.operation_events set payload = payload where id = $1"
DELETE = "delete from soc.operation_events where id = $1"
TRUNCATE = "truncate soc.operation_events"
LOG_EVENT = (
    "select (soc.log_event($1, $2, 'soc-cloud', '{}'::jsonb, null, null, null, null, null,"
    " $3::soc.event_severity)).severity::text"
)
SAFETY_RESERVED = [
    pytest.param("geofence_warning", "safety", id="warning-kind-as-safety"),
    pytest.param("transition_refused", "safety", id="transition-refused-as-safety"),
    pytest.param("operation_created", "safety", id="info-kind-as-safety"),
    pytest.param("telemetry_stale", "error", id="safety-kind-as-error"),
    pytest.param("telemetry_stale", "warning", id="safety-kind-as-warning"),
    pytest.param("geofence_breach", "info", id="safety-kind-as-info"),
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


async def operation_of(admin: asyncpg.Connection, organization_id: uuid.UUID) -> uuid.UUID:
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning id",
        organization_id,
    )
    assert isinstance(operation, uuid.UUID)
    return operation


async def test_the_event_kinds_are_the_contracts_kinds_with_their_severities(
    admin: asyncpg.Connection,
) -> None:
    rows = await admin.fetch("select kind, severity::text as severity from soc.event_kinds")
    assert {row["kind"]: row["severity"] for row in rows} == SEVERITY_OF


@pytest.mark.parametrize(("kind", "severity"), SAFETY_RESERVED)
async def test_safety_is_reserved_for_the_safety_kinds(
    kind: str, severity: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await admin.fetchval(LOG_EVENT, operation, kind, severity)
    assert refusal.value.constraint_name == "operation_event_safety_reserved"


async def test_a_safety_kind_is_logged_as_safety(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    assert await admin.fetchval(LOG_EVENT, operation, "geofence_breach", "safety") == "safety"


@pytest.mark.parametrize("kind", ["transition_refused", "geofence_warning", "automatic_return"])
async def test_a_warning_kind_may_be_raised_to_error_by_its_writer(
    kind: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    assert await admin.fetchval(LOG_EVENT, operation, kind, "error") == "error"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="The trigger operation_event_severity says a warning kind is never lowered (IR-EVT-01), "
    "but it tests only for safety: a warning kind is written at info",
)
@pytest.mark.parametrize("kind", ["transition_refused", "geofence_warning", "automatic_return"])
async def test_a_warning_kind_is_never_lowered_to_info(
    kind: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    refusal = await refusal_of(admin.fetchval(LOG_EVENT, operation, kind, "info"))
    assert isinstance(refusal, asyncpg.CheckViolationError)


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="events.json gives command_outcome the severity info, and IR-EVT-01 says a kind's "
    "severity is the contract's: the database writes a warning for it without a word",
)
async def test_an_info_kind_is_not_written_as_a_warning(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    refusal = await refusal_of(admin.fetchval(LOG_EVENT, operation, "command_outcome", "warning"))
    assert isinstance(refusal, asyncpg.CheckViolationError)


@pytest.mark.parametrize(
    ("kind", "severity"),
    [
        pytest.param("transition_refused", "warning", id="warning-kind"),
        pytest.param("landed", "info", id="info-kind"),
        pytest.param("geofence_breach", "safety", id="safety-kind"),
    ],
)
async def test_log_event_fills_the_kinds_severity_when_none_is_given(
    kind: str, severity: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    filled = await admin.fetchval(
        "select (soc.log_event($1, $2, 'soc-cloud')).severity::text", operation, kind
    )
    assert filled == severity


async def test_log_event_refuses_a_kind_outside_the_contract(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as refusal:
        await admin.fetchval(
            "select soc.log_event($1, 'operation_exploded', 'soc-cloud')", operation
        )
    assert refusal.value.constraint_name == "operation_events_kind_fkey"


async def test_log_event_refuses_an_operation_that_does_not_exist(
    admin: asyncpg.Connection,
) -> None:
    with pytest.raises(asyncpg.NoDataFoundError) as refusal:
        await admin.fetchval("select soc.log_event($1, 'landed', 'aircraft')", uuid.uuid4())
    assert refusal.value.sqlstate == "P0002"


@asynccontextmanager
async def as_role(
    role: str,
    member: Member,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    migrated: EphemeralPostgres,
    service_passwords: dict[str, str],
) -> AsyncIterator[asyncpg.Connection]:
    """A connection acting as the role, whose changes are undone when the block ends."""
    if role == "authenticated":
        async with acting_as(session, member.user_id) as connection:
            yield connection
    elif role == "admin":
        async with rolled_back(admin) as connection:
            yield connection
    else:
        connection = await migrated.connect(role, service_passwords[role])
        try:
            async with rolled_back(connection) as service:
                yield service
        finally:
            await connection.close()


@pytest.mark.parametrize("role", ["authenticated", "soc_cloud", "soc_operations", "admin"])
@pytest.mark.parametrize(
    ("statement", "takes_entry"),
    [
        pytest.param(UPDATE, True, id="update"),
        pytest.param(DELETE, True, id="delete"),
        pytest.param(TRUNCATE, False, id="truncate"),
    ],
)
async def test_the_log_is_never_changed_nor_removed_by_any_role(
    role: str,
    statement: str,
    takes_entry: bool,
    admin: asyncpg.Connection,
    session: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
    service_passwords: dict[str, str],
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    entry = await admin.fetchval(
        "select id from soc.operation_events where operation_id = $1", operation
    )
    arguments: tuple[Any, ...] = (entry,) if takes_entry else ()
    async with as_role(role, member, admin, session, migrated, service_passwords) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError) as refusal:
            await connection.execute(statement, *arguments)
        if role == "admin":
            assert "append-only" in refusal.value.message
    assert (
        await admin.fetchval("select count(*) from soc.operation_events where id = $1", entry) == 1
    )


async def test_every_new_entry_is_broadcast_whole_on_the_organizations_state_topic(
    todays_partition: None, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_of(admin, member.organization_id)
    entry = await admin.fetchrow(
        "select * from soc.log_event($1, 'landed', 'aircraft', '{\"mode_code\": 3}'::jsonb)",
        operation,
    )
    assert entry is not None
    rows = await admin.fetch(
        "select event, private, payload from realtime.messages"
        " where topic = $1 and event = 'operation_event' order by inserted_at, id",
        f"org:{member.organization_id}:soc:state",
    )
    assert [row["private"] for row in rows] == [True, True]
    payloads = [json.loads(row["payload"]) for row in rows]
    assert [set(payload) for payload in payloads] == [ENTRY_COLUMNS, ENTRY_COLUMNS]
    assert payloads[-1]["id"] == str(entry["id"])
    assert (payloads[-1]["kind"], payloads[-1]["payload"]) == ("landed", {"mode_code": 3})
