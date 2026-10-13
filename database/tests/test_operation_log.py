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
KINDS: dict[str, dict[str, Any]] = CONTRACT["kinds"]
SEVERITY_OF: dict[str, str] = {kind: spec["severity"] for kind, spec in KINDS.items()}
SOURCES_OF: dict[str, list[str]] = {kind: sorted(spec["sources"]) for kind, spec in KINDS.items()}
PAYLOAD_OF: dict[str, list[str]] = {kind: sorted(spec["payload"]) for kind, spec in KINDS.items()}
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
    "select (soc.log_event($1, $2, $3::soc.event_source, $4::jsonb, null, null, null, null, null,"
    " $5::soc.event_severity)).severity::text"
)
# Each kind is written with a source the contract lists and every payload key it names.
SAFETY_RESERVED = [
    pytest.param("geofence_warning", "safety", id="warning-kind-as-safety"),
    pytest.param("transition_refused", "safety", id="transition-refused-as-safety"),
    pytest.param("operation_created", "safety", id="info-kind-as-safety"),
]
RAISED = [
    pytest.param("transition_refused", "error", id="transition-refused-to-error"),
    pytest.param("geofence_warning", "error", id="geofence-warning-to-error"),
    pytest.param("automatic_return", "error", id="automatic-return-to-error"),
    pytest.param("landed", "warning", id="landed-to-warning"),
    pytest.param("landed", "error", id="landed-to-error"),
    pytest.param("command_outcome", "warning", id="refused-command-outcome-as-warning"),
]
LOWERED = [
    pytest.param("transition_refused", "info", id="transition-refused-to-info"),
    pytest.param("geofence_warning", "info", id="geofence-warning-to-info"),
    pytest.param("automatic_return", "info", id="automatic-return-to-info"),
    pytest.param("telemetry_stale", "warning", id="telemetry-stale-to-warning"),
    pytest.param("telemetry_stale", "error", id="telemetry-stale-to-error"),
    pytest.param("geofence_breach", "error", id="geofence-breach-to-error"),
    pytest.param("geofence_breach", "info", id="geofence-breach-to-info"),
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


def complete_payload(kind: str) -> str:
    """The payload the contract asks for: every key it names, each one present."""
    return json.dumps(dict.fromkeys(PAYLOAD_OF[kind]))


async def log(
    admin: asyncpg.Connection,
    operation: uuid.UUID,
    kind: str,
    *,
    severity: str | None = None,
    source: str | None = None,
    payload: str | None = None,
) -> str:
    """Writes an entry of the kind and returns the severity the database gave it."""
    severity_written = await admin.fetchval(
        LOG_EVENT,
        operation,
        kind,
        source or SOURCES_OF[kind][0],
        payload or complete_payload(kind),
        severity,
    )
    assert isinstance(severity_written, str)
    return severity_written


async def test_the_event_kinds_match_the_contract_in_severity_sources_and_payload(
    admin: asyncpg.Connection,
) -> None:
    rows = await admin.fetch(
        "select kind, severity::text as severity, sources::text[] as sources, payload"
        " from soc.event_kinds"
    )
    listed = {row["kind"]: row for row in rows}
    assert {kind: row["severity"] for kind, row in listed.items()} == SEVERITY_OF
    assert {kind: sorted(row["sources"]) for kind, row in listed.items()} == SOURCES_OF
    assert {kind: sorted(row["payload"]) for kind, row in listed.items()} == PAYLOAD_OF


@pytest.mark.parametrize(("kind", "severity"), SAFETY_RESERVED)
async def test_safety_is_reserved_for_the_safety_kinds(
    kind: str, severity: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await log(admin, operation, kind, severity=severity)
    assert refusal.value.constraint_name == "operation_event_safety_reserved"


async def test_a_safety_kind_is_logged_as_safety(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    assert await log(admin, operation, "geofence_breach", severity="safety") == "safety"


@pytest.mark.parametrize(("kind", "severity"), RAISED)
async def test_a_writer_may_raise_an_entry_above_its_kinds_severity(
    kind: str, severity: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    assert await log(admin, operation, kind, severity=severity) == severity


@pytest.mark.parametrize(("kind", "severity"), LOWERED)
async def test_an_entry_is_never_lowered_below_its_kinds_severity(
    kind: str, severity: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await log(admin, operation, kind, severity=severity)
    assert refusal.value.constraint_name == "operation_event_severity_floor"


@pytest.mark.parametrize(
    ("kind", "source"),
    [
        pytest.param("operation_created", "soc-cloud", id="operator-kind-from-the-cloud"),
        pytest.param("landed", "soc-cloud", id="aircraft-kind-from-the-cloud"),
        pytest.param("transition_refused", "operator", id="service-kind-from-the-operator"),
    ],
)
async def test_an_entry_comes_from_a_source_its_kind_lists(
    kind: str, source: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await log(admin, operation, kind, source=source)
    assert refusal.value.constraint_name == "operation_event_source_listed"


@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        pytest.param("landed", {}, id="no-keys"),
        pytest.param(
            "geofence_breach",
            {"position": None, "height_m": None, "distance_outside_m": None},
            id="sampled-at-missing",
        ),
        pytest.param(
            "flight_status_changed", {"status": "ok", "percent": 100}, id="result-missing"
        ),
    ],
)
async def test_an_entry_carries_every_payload_key_its_kind_lists(
    kind: str, payload: dict[str, Any], admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await log(admin, operation, kind, payload=json.dumps(payload))
    assert refusal.value.constraint_name == "operation_event_payload_keys"


async def test_a_listed_payload_key_holding_null_counts_as_carried(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_of(admin, (await tenancy.member()).organization_id)
    assert await log(admin, operation, "landed", payload='{"mode_code": null}') == "info"


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
    assert await log(admin, operation, kind) == severity


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
    with pytest.raises(asyncpg.PostgresError):
        await admin.fetchval("select soc.log_event($1, 'landed', 'aircraft')", uuid.uuid4())


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
