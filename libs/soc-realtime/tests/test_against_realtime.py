from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import aiohttp
import asyncpg
import pytest

from soc_database.harness import Tenancy
from soc_database.realtime import RealtimeStack
from soc_realtime import Endpoint, HttpBroadcast, Message, RealtimeSocket
from soc_realtime.socket import Connector
from soc_realtime.testing import Subscriber
from soc_supervision import Backoff

pytestmark = pytest.mark.lane

Until = Callable[..., Awaitable[None]]


def telemetry(organization: object) -> str:
    return f"org:{organization}:soc:telemetry"


@asynccontextmanager
async def service_socket(
    stack: RealtimeStack, topic: str, connector: Connector, until: Until
) -> AsyncIterator[RealtimeSocket]:
    socket = RealtimeSocket(
        Endpoint(stack.base, stack.service_key()),
        [topic],
        connector=connector,
        backoff=Backoff(initial_s=0.1),
    )
    task = asyncio.create_task(socket.run())
    try:
        await until(lambda: socket.joined(topic), 10)
        yield socket
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_a_member_receives_what_the_service_broadcasts(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector, until: Until
) -> None:
    member = await tenancy.member()
    topic = telemetry(member.organization_id)
    token = migrated.member_token(member.user_id)
    async with (
        service_socket(migrated, topic, connector, until) as socket,
        Subscriber(migrated.base, token, topic, connector) as browser,
    ):
        assert browser.joined, browser.reason
        await socket.send(Message(topic, "sample", {"battery_pct": 87}))
        received = await browser.broadcast()
    assert received["event"] == "sample"
    assert received["payload"] == {"battery_pct": 87}


async def test_a_member_of_another_organization_is_refused(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector
) -> None:
    member = await tenancy.member()
    stranger = await tenancy.member()
    token = migrated.member_token(stranger.user_id)
    async with Subscriber(
        migrated.base, token, telemetry(member.organization_id), connector
    ) as browser:
        assert not browser.joined
        assert browser.reason.startswith("Unauthorized")


async def test_a_member_of_a_deleted_organization_is_refused(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector
) -> None:
    member = await tenancy.member()
    await tenancy.soft_delete_organization(member.organization_id)
    token = migrated.member_token(member.user_id)
    async with Subscriber(
        migrated.base, token, telemetry(member.organization_id), connector
    ) as browser:
        assert not browser.joined


async def test_an_anonymous_client_is_refused(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector
) -> None:
    member = await tenancy.member()
    token = migrated.anonymous_token()
    async with Subscriber(
        migrated.base, token, telemetry(member.organization_id), connector
    ) as browser:
        assert not browser.joined


async def test_a_member_cannot_send_on_a_soc_topic(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector, until: Until
) -> None:
    member = await tenancy.member()
    colleague = await tenancy.user()
    await tenancy.join(colleague, member.organization_id, "viewer")
    topic = telemetry(member.organization_id)
    async with (
        service_socket(migrated, topic, connector, until) as socket,
        Subscriber(
            migrated.base, migrated.member_token(member.user_id), topic, connector
        ) as sender,
        Subscriber(migrated.base, migrated.member_token(colleague), topic, connector) as listener,
    ):
        assert sender.joined and listener.joined
        await sender.send("sample", {"forged": True})
        assert await listener.silent_for(1.0)
        await socket.send(Message(topic, "sample", {"genuine": True}))
        assert (await listener.broadcast())["payload"] == {"genuine": True}


async def test_the_http_fallback_reaches_members(
    migrated: RealtimeStack,
    tenancy: Tenancy,
    connector: Connector,
    http_session: aiohttp.ClientSession,
) -> None:
    member = await tenancy.member()
    topic = telemetry(member.organization_id)
    http = HttpBroadcast(Endpoint(migrated.base, migrated.service_key()), http_session)
    async with Subscriber(
        migrated.base, migrated.member_token(member.user_id), topic, connector
    ) as browser:
        assert await http.send([Message(topic, "sample", {"through": "http"})])
        assert (await browser.broadcast())["payload"] == {"through": "http"}


async def test_a_send_from_sql_reaches_members_when_it_commits(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector, owner: asyncpg.Connection
) -> None:
    member = await tenancy.member()
    topic = f"org:{member.organization_id}:soc:state"
    async with Subscriber(
        migrated.base, migrated.member_token(member.user_id), topic, connector
    ) as browser:
        rolled_back = owner.transaction()
        await rolled_back.start()
        await owner.execute(
            "select realtime.send($1::jsonb, 'changed', $2, true)",
            json.dumps({"committed": False}),
            topic,
        )
        await rolled_back.rollback()
        await owner.execute(
            "select realtime.send($1::jsonb, 'changed', $2, true)",
            json.dumps({"committed": True}),
            topic,
        )
        received = await browser.broadcast()
    assert received["event"] == "changed"
    message_id = received["payload"].pop("id")
    assert received["payload"] == {"committed": True}
    assert uuid.UUID(message_id)


async def test_the_socket_joins_again_after_realtime_restarts(
    migrated: RealtimeStack, tenancy: Tenancy, connector: Connector, until: Until
) -> None:
    member = await tenancy.member()
    topic = telemetry(member.organization_id)
    async with service_socket(migrated, topic, connector, until) as socket:
        up_since = socket.health.since
        await asyncio.to_thread(migrated.restart_realtime)
        await until(
            lambda: socket.health.up and socket.health.since > up_since and socket.joined(topic),
            30,
        )
        async with Subscriber(
            migrated.base, migrated.member_token(member.user_id), topic, connector
        ) as browser:
            await socket.send(Message(topic, "sample", {"after": "restart"}))
            assert (await browser.broadcast())["payload"] == {"after": "restart"}
