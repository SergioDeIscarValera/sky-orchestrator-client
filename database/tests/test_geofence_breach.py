from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Operations, Tenancy, acting_as

BREACH = "select soc.record_geofence_breach($1, $2, $3::jsonb, $4)"
OUTSIDE = {"position": [-4.7300, 41.6500], "height_m": 42.5, "distance_outside_m": 12.5}
SAMPLED = datetime(2026, 10, 13, 10, 0, 0, tzinfo=UTC)
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


async def breach(
    connection: asyncpg.Connection,
    flight: uuid.UUID,
    intent: uuid.UUID,
    outside: dict[str, object] = OUTSIDE,
    sampled: datetime = SAMPLED,
) -> bool:
    answer = await connection.fetchval(BREACH, flight, intent, json.dumps(outside), sampled)
    assert isinstance(answer, bool)
    return answer


async def intents_of(admin: asyncpg.Connection, flight: uuid.UUID) -> int:
    count = await admin.fetchval(
        "select count(*) from soc.command_intents where flight_id = $1", flight
    )
    assert isinstance(count, int)
    return count


async def test_a_breach_is_recorded_once_per_flight(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    first, second = uuid.uuid4(), uuid.uuid4()
    assert await breach(soc_cloud, flown.flight_id, first) is True
    assert (
        await breach(soc_cloud, flown.flight_id, second, sampled=SAMPLED + timedelta(seconds=1))
        is False
    )
    assert await intents_of(admin, flown.flight_id) == 1
    kept = await admin.fetch(
        "select command_id, severity::text as severity, source::text as source, occurred_at"
        " from soc.operation_events where flight_id = $1 and kind = 'geofence_breach'",
        flown.flight_id,
    )
    assert [
        (row["command_id"], row["severity"], row["source"], row["occurred_at"]) for row in kept
    ] == [(first, "safety", "soc-cloud", SAMPLED)]


async def test_the_return_home_is_sent_then_settled_by_its_reply_like_any_other(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    intent = uuid.uuid4()
    assert await breach(soc_cloud, flown.flight_id, intent) is True
    sent = await admin.fetchrow(
        "select verb::text as verb, status::text as status, sent_at, requested_by, payload"
        " from soc.command_intents where id = $1",
        intent,
    )
    assert sent is not None
    assert (sent["verb"], sent["status"], sent["requested_by"]) == ("return_home", "sent", None)
    assert sent["sent_at"] is not None
    assert json.loads(sent["payload"]) == {}
    settled = await soc_cloud.fetch("select * from soc.record_command_reply($1, 0)", intent)
    assert [(row["status"], row["result"]) for row in settled] == [("accepted", 0)]
    outcome = await admin.fetchrow(
        "select severity::text as severity, payload from soc.operation_events"
        " where command_id = $1 and kind = 'command_outcome'",
        intent,
    )
    assert outcome is not None
    assert (outcome["severity"], json.loads(outcome["payload"])) == (
        "info",
        {"verb": "return_home", "status": "accepted", "result": 0},
    )
    requested = await admin.fetch(
        "select source::text as source, actor_id from soc.operation_events"
        " where command_id = $1 and kind = 'command_requested'",
        intent,
    )
    # soc-cloud sent it on its own: neither a member nor soc-operations asked for it.
    assert [(row["source"], row["actor_id"]) for row in requested] == [("soc-cloud", None)]


async def test_a_flight_that_ended_records_no_breach(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    await admin.execute(
        "update soc.flights set ended_at = now(), end_reason = 'completed' where id = $1",
        flown.flight_id,
    )
    before = await intents_of(admin, flown.flight_id)
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4()) is False
    assert await intents_of(admin, flown.flight_id) == before
    breached = await admin.fetchval(
        "select breached_at from soc.flights where id = $1", flown.flight_id
    )
    assert breached is None


async def test_the_breach_entry_carries_the_keys_the_contract_lists(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    intent = uuid.uuid4()
    assert await breach(soc_cloud, flown.flight_id, intent) is True
    payload = await admin.fetchval(
        "select payload from soc.operation_events"
        " where flight_id = $1 and kind = 'geofence_breach'",
        flown.flight_id,
    )
    assert set(json.loads(payload)) == {"position", "height_m", "distance_outside_m", "sampled_at"}


async def test_a_breach_missing_a_listed_key_is_refused_and_records_nothing(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    intent = uuid.uuid4()
    incomplete = {"position": [-4.73, 41.65], "height_m": 42.5}
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await breach(soc_cloud, flown.flight_id, intent, outside=incomplete)
    assert refusal.value.constraint_name == "operation_event_payload_keys"
    assert await intents_of(admin, flown.flight_id) == 0


async def test_an_unknown_flight_records_nothing_and_returns_false(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection
) -> None:
    intent = uuid.uuid4()
    assert await breach(soc_cloud, uuid.uuid4(), intent) is False
    assert (
        await admin.fetchval("select count(*) from soc.command_intents where id = $1", intent) == 0
    )


async def test_a_breach_on_a_closed_operation_inserts_the_intent_and_logs_nothing(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    intent = uuid.uuid4()
    assert await breach(soc_cloud, flown.flight_id, intent) is True
    assert (
        await admin.fetchval("select status::text from soc.command_intents where id = $1", intent)
        == "sent"
    )
    logged = await admin.fetchval(
        "select count(*) from soc.operation_events where flight_id = $1", flown.flight_id
    )
    assert logged == 0


async def test_a_second_breach_on_a_closed_operation_records_nothing(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4()) is True
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4()) is False
    assert await intents_of(admin, flown.flight_id) == 1


async def test_only_soc_cloud_may_record_a_breach(
    session: asyncpg.Connection,
    soc_operations: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("owner")
    flown = await Operations(admin).flown(member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await breach(connection, flown.flight_id, uuid.uuid4())
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await breach(soc_operations, flown.flight_id, uuid.uuid4())
    assert await intents_of(admin, flown.flight_id) == 0


async def breached_at_of(admin: asyncpg.Connection, flight: uuid.UUID) -> datetime | None:
    when = await admin.fetchval("select breached_at from soc.flights where id = $1", flight)
    assert when is None or isinstance(when, datetime)
    return when


async def test_a_flight_is_not_breached_until_a_breach_is_recorded(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    assert await breached_at_of(admin, flown.flight_id) is None


async def test_a_breach_sets_breached_at_once_and_a_second_breach_leaves_it(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4()) is True
    assert await breached_at_of(admin, flown.flight_id) == SAMPLED
    later = SAMPLED + timedelta(seconds=7)
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4(), sampled=later) is False
    assert await breached_at_of(admin, flown.flight_id) == SAMPLED


async def test_an_unknown_flight_is_not_breached_and_returns_false(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection
) -> None:
    unknown = uuid.uuid4()
    assert await breach(soc_cloud, unknown, uuid.uuid4()) is False
    assert await admin.fetchval("select count(*) from soc.flights where id = $1", unknown) == 0


async def test_the_flight_broadcast_carries_when_the_flight_was_breached(
    todays_partition: None,
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    assert await breach(soc_cloud, flown.flight_id, uuid.uuid4()) is True
    rows = await admin.fetch(
        "select payload from realtime.messages where topic = $1 and event = 'flight'"
        " order by inserted_at, id",
        f"org:{flown.organization_id}:soc:state",
    )
    payloads = [json.loads(row["payload"]) for row in rows]
    own = [payload for payload in payloads if payload["id"] == str(flown.flight_id)]
    assert datetime.fromisoformat(own[-1]["breached_at"]) == SAMPLED
