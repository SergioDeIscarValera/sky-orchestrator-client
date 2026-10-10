from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as

GATEWAY = "SOTESTDOCK01"
INSERT = """
insert into soc.command_intents
  (client_request_id, organization_id, operation_id, flight_id, gateway_sn, verb,
   payload, requested_by, requested_at)
values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, coalesce($9, now()))
returning *
"""
FORWARD = [
    ("pending", "sent"),
    ("pending", "expired"),
    ("pending", "failed"),
    ("sent", "accepted"),
    ("sent", "refused"),
    ("sent", "timed_out"),
]
STATUSES = ["pending", "sent", "accepted", "refused", "failed", "timed_out", "expired"]


async def request(
    connection: asyncpg.Connection,
    member: Member,
    *,
    verb: str = "return_home",
    requested_at: Any = None,
    client_request_id: uuid.UUID | None = None,
) -> asyncpg.Record:
    row = await connection.fetchrow(
        INSERT,
        client_request_id or uuid.uuid4(),
        member.organization_id,
        uuid.uuid4(),
        uuid.uuid4(),
        GATEWAY,
        verb,
        json.dumps({}),
        member.user_id,
        requested_at,
    )
    assert row is not None
    return row


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


MOVE = """
update soc.command_intents
   set status = $2::soc.command_status,
       sent_at = case when $2::text in ('sent', 'accepted', 'refused', 'timed_out') then now() end,
       replied_at = case when $2::text in ('accepted', 'refused') then now() end,
       result = case when $2::text in ('accepted', 'refused') then 0 end
 where id = $1
"""
GUARD = "command_intent_moves_forward"


async def force(admin: asyncpg.Connection, intent: uuid.UUID, status: str) -> None:
    await admin.execute(f"alter table soc.command_intents disable trigger {GUARD}")
    try:
        await admin.execute(MOVE, intent, status)
    finally:
        await admin.execute(f"alter table soc.command_intents enable trigger {GUARD}")


async def test_an_intent_is_announced_once_it_commits(
    session: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member()
    heard: asyncio.Queue[str] = asyncio.Queue()
    listener = await migrated.connect()
    await listener.add_listener(
        "soc_command_intents", lambda *arguments: heard.put_nowait(arguments[3])
    )
    try:
        rolled_back = session.transaction()
        await rolled_back.start()
        await request(session, member)
        await rolled_back.rollback()
        committed = await request(admin, member)
        assert await asyncio.wait_for(heard.get(), 5) == str(committed["id"])
        assert heard.empty()
    finally:
        await listener.close()


async def test_soc_operations_may_request_and_soc_cloud_may_not(
    soc_operations: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    row = await request(soc_operations, member)
    assert row["status"] == "pending"
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await request(soc_cloud, member)


async def test_a_claim_runs_once(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    claimed = await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    again = await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    assert [row["status"] for row in claimed] == ["sent"]
    assert claimed[0]["sent_at"] is not None
    assert again == []


async def test_a_late_claim_expires_instead_of_running(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    late = await request(
        admin, member, requested_at=await admin.fetchval("select now() - interval '11 seconds'")
    )
    claimed = await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", late["id"])
    assert [(row["status"], row["sent_at"]) for row in claimed] == [("expired", None)]


async def test_a_reply_is_recorded_once_with_its_result(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    accepted = (await request(admin, await tenancy.member()))["id"]
    refused = (await request(admin, await tenancy.member()))["id"]
    for intent in (accepted, refused):
        await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    yes = await soc_cloud.fetch("select * from soc.record_command_reply($1, 0)", accepted)
    no = await soc_cloud.fetch("select * from soc.record_command_reply($1, 314010)", refused)
    twice = await soc_cloud.fetch("select * from soc.record_command_reply($1, 0)", accepted)
    assert [(row["status"], row["result"]) for row in yes] == [("accepted", 0)]
    assert [(row["status"], row["result"]) for row in no] == [("refused", 314010)]
    assert yes[0]["replied_at"] is not None
    assert twice == []


async def test_a_sent_command_without_a_reply_times_out(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    timed_out = await soc_cloud.fetch("select * from soc.time_out_command_intent($1)", intent)
    assert [row["status"] for row in timed_out] == ["timed_out"]


async def test_a_command_its_schema_refuses_fails_before_sending(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    failed = await soc_cloud.fetch("select * from soc.fail_command_intent($1)", intent)
    assert [row["status"] for row in failed] == ["failed"]
    assert await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent) == []


@pytest.mark.parametrize(
    ("before", "after"),
    [(b, a) for b in STATUSES for a in STATUSES if b != a and (b, a) not in FORWARD],
)
async def test_a_command_never_moves_backwards_or_sideways(
    before: str, after: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    await force(admin, intent, before)
    with pytest.raises(asyncpg.CheckViolationError, match="cannot become"):
        await admin.execute(MOVE, intent, after)


@pytest.mark.parametrize(
    "change",
    [
        "update soc.command_intents set verb = 'execute' where id = $1",
        "update soc.command_intents set payload = '{\"changed\": true}' where id = $1",
        "update soc.command_intents set gateway_sn = 'OTHERDOCK01' where id = $1",
        "update soc.command_intents set flight_id = gen_random_uuid() where id = $1",
        "update soc.command_intents set requested_at = now() - interval '1 hour' where id = $1",
    ],
)
async def test_what_was_asked_never_changes(
    change: str, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    with pytest.raises(asyncpg.CheckViolationError, match="never changes"):
        await admin.execute(change, intent)


async def test_who_asked_is_forgotten_when_their_profile_goes(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member(role="editor")
    intent = (await request(admin, member))["id"]
    await admin.execute("delete from public.memberships where profile_id = $1", member.user_id)
    await admin.execute("delete from auth.users where id = $1", member.user_id)
    assert (
        await admin.fetchval("select requested_by from soc.command_intents where id = $1", intent)
        is None
    )


async def test_a_browser_request_id_is_unique_per_organization(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    first, second = await tenancy.member(), await tenancy.member()
    key = uuid.uuid4()
    await request(admin, first, client_request_id=key)
    await request(admin, second, client_request_id=key)
    with pytest.raises(asyncpg.UniqueViolationError):
        await request(admin, first, client_request_id=key)


async def test_members_read_their_organizations_commands_only(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member, stranger = await tenancy.member(), await tenancy.member()
    intent = (await request(admin, member))["id"]
    async with acting_as(session, member.user_id) as connection:
        assert (
            await connection.fetchval(
                "select count(*) from soc.command_intents where id = $1", intent
            )
            == 1
        )
    async with acting_as(session, stranger.user_id) as connection:
        assert (
            await connection.fetchval(
                "select count(*) from soc.command_intents where id = $1", intent
            )
            == 0
        )
    async with acting_as(session, None) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.fetchval("select count(*) from soc.command_intents")


async def test_a_member_cannot_write_commands_directly(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    intent = (await request(admin, member))["id"]
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await request(connection, member)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.execute(
                "update soc.command_intents set status = 'sent' where id = $1", intent
            )


async def test_soc_cloud_cannot_rewrite_what_was_asked(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    intent = (await request(admin, await tenancy.member()))["id"]
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.execute(
            "update soc.command_intents set payload = '{}' where id = $1", intent
        )


async def test_every_change_is_broadcast_on_the_organizations_state_topic(
    todays_partition: None,
    admin: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member()
    intent = (await request(admin, member))["id"]
    await soc_cloud.fetch("select * from soc.claim_command_intent($1, 10)", intent)
    rows = await admin.fetch(
        "select event, private, payload from realtime.messages"
        " where topic = $1 and payload->>'id' = $2 order by inserted_at, id",
        f"org:{member.organization_id}:soc:state",
        str(intent),
    )
    assert [(row["event"], row["private"]) for row in rows] == [("command_intent", True)] * 2
    assert [json.loads(row["payload"])["status"] for row in rows] == ["pending", "sent"]
