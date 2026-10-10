from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Tenancy, impersonate

PROBE = "insert into realtime.messages (topic, extension) values ($1, 'broadcast')"


@pytest.fixture(scope="session", autouse=True)
async def todays_partition(migrated: EphemeralPostgres) -> AsyncIterator[None]:
    connection = await migrated.connect("supabase_admin")
    try:
        await connection.execute(
            "create table if not exists realtime.messages_soc_tests "
            "partition of realtime.messages "
            "for values from (now() - interval '2 days') to (now() + interval '2 days')"
        )
        yield
    finally:
        await connection.close()


async def can_receive(session: asyncpg.Connection, user_id: uuid.UUID | None, topic: str) -> bool:
    transaction = session.transaction()
    await transaction.start()
    try:
        await session.execute(PROBE, topic)
        await impersonate(session, user_id, topic=topic)
        visible = await session.fetchval(
            "select count(*) from realtime.messages where topic = $1 and extension = 'broadcast'",
            topic,
        )
        return bool(visible)
    finally:
        await transaction.rollback()


async def can_send(session: asyncpg.Connection, user_id: uuid.UUID | None, topic: str) -> bool:
    transaction = session.transaction()
    await transaction.start()
    try:
        await impersonate(session, user_id, topic=topic)
        await session.execute(PROBE, topic)
    except asyncpg.InsufficientPrivilegeError:
        return False
    else:
        return True
    finally:
        await transaction.rollback()


def telemetry(organization_id: uuid.UUID) -> str:
    return f"org:{organization_id}:soc:telemetry"


async def test_a_member_receives_its_organizations_topics(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("viewer")
    assert await can_receive(session, member.user_id, telemetry(member.organization_id))
    assert await can_receive(session, member.user_id, f"org:{member.organization_id}:soc:state")


async def test_nobody_else_does(session: asyncpg.Connection, tenancy: Tenancy) -> None:
    member = await tenancy.member()
    other = await tenancy.member()
    stranger = await tenancy.user()
    topic = telemetry(member.organization_id)
    assert not await can_receive(session, other.user_id, topic)
    assert not await can_receive(session, stranger, topic)
    assert not await can_receive(session, None, topic)


async def test_a_soft_deleted_organization_stops_receiving(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    await tenancy.soft_delete_organization(member.organization_id)
    assert not await can_receive(session, member.user_id, telemetry(member.organization_id))


async def test_no_client_may_send_on_a_soc_topic(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("owner")
    assert not await can_send(session, member.user_id, telemetry(member.organization_id))
    assert not await can_send(session, None, telemetry(member.organization_id))


async def test_a_malformed_topic_is_refused_without_an_error(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    assert not await can_receive(session, member.user_id, "org:not-a-uuid:soc:telemetry")


async def test_other_topics_pass_through_the_guards(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    other = await tenancy.member()
    await admin.execute(
        "create policy vo2_example on realtime.messages for select to authenticated using (true)"
    )
    try:
        assert await can_receive(session, member.user_id, "farm:anything:devices")
        assert not await can_receive(session, member.user_id, telemetry(other.organization_id))
    finally:
        await admin.execute("drop policy vo2_example on realtime.messages")
