from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import pytest

from soc_realtime import Endpoint, Message, NotJoinedError, RealtimeSocket
from soc_realtime.testing import FakePhoenix
from soc_supervision import Backoff

Until = Callable[..., Awaitable[None]]
KEY = ".".join(("h" * 20, "p" * 40, "s" * 43))
TELEMETRY = "org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:telemetry"
STATE = "org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:state"


def socket_for(phoenix: FakePhoenix, **options: Any) -> RealtimeSocket:
    return RealtimeSocket(
        Endpoint(phoenix.base, KEY),
        [TELEMETRY, STATE],
        backoff=Backoff(initial_s=0.01),
        **options,
    )


@asynccontextmanager
async def running(socket: RealtimeSocket) -> AsyncIterator[None]:
    task = asyncio.create_task(socket.run())
    try:
        yield
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def test_the_endpoint_derives_both_urls_through_the_gateway() -> None:
    endpoint = Endpoint("https://supabase.example.org/realtime/v1/", KEY)
    assert endpoint.websocket_url() == (
        f"wss://supabase.example.org/realtime/v1/websocket?apikey={KEY}&vsn=1.0.0"
    )
    assert endpoint.broadcast_url() == "https://supabase.example.org/realtime/v1/api/broadcast"


def test_the_endpoint_derives_both_urls_on_realtime_itself() -> None:
    endpoint = Endpoint("http://localhost:4000/socket", KEY)
    assert endpoint.websocket_url().startswith("ws://localhost:4000/socket/websocket?")
    assert endpoint.broadcast_url() == "http://localhost:4000/api/broadcast"


def test_the_key_never_shows() -> None:
    assert KEY not in repr(Endpoint("http://kong:8000/realtime/v1", KEY))


async def test_every_topic_is_joined_as_a_private_channel_with_the_key(
    phoenix: FakePhoenix, until: Until
) -> None:
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: socket.joined(TELEMETRY) and socket.joined(STATE))
    assert phoenix.queries[0] == {"apikey": [KEY], "vsn": ["1.0.0"]}
    assert [join["topic"] for join in phoenix.joins] == [
        f"realtime:{TELEMETRY}",
        f"realtime:{STATE}",
    ]
    payload = phoenix.joins[0]["payload"]
    assert payload["access_token"] == KEY
    assert payload["config"]["private"] is True
    assert payload["config"]["broadcast"] == {"ack": False, "self": False}
    assert phoenix.joins[0]["ref"] == phoenix.joins[0]["join_ref"]


async def test_a_broadcast_is_framed_on_its_joined_channel(
    phoenix: FakePhoenix, until: Until
) -> None:
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: socket.joined(TELEMETRY))
        await socket.send(Message(TELEMETRY, "sample", {"battery_pct": 87}))
        await until(lambda: phoenix.broadcasts)
    (frame,) = phoenix.broadcasts
    assert frame["topic"] == f"realtime:{TELEMETRY}"
    assert frame["event"] == "broadcast"
    assert frame["payload"] == {
        "type": "broadcast",
        "event": "sample",
        "payload": {"battery_pct": 87},
    }
    assert frame["join_ref"] == phoenix.joins[0]["ref"]
    assert frame["ref"] != frame["join_ref"]


async def test_a_topic_not_joined_cannot_be_sent_on(phoenix: FakePhoenix) -> None:
    socket = socket_for(phoenix)
    with pytest.raises(NotJoinedError, match="telemetry"):
        await socket.send(Message(TELEMETRY, "sample", {}))


async def test_a_refused_join_keeps_it_down_and_says_why(
    phoenix: FakePhoenix, until: Until
) -> None:
    phoenix.refused_topics.add(f"realtime:{STATE}")
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: len(phoenix.connections) >= 2)
        assert not socket.joined(TELEMETRY)
        assert socket.health.error == (f"ChannelError: joining {STATE} was refused: Unauthorized")


async def test_a_closed_socket_is_replaced_and_every_topic_joined_again(
    phoenix: FakePhoenix, until: Until
) -> None:
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: socket.joined(STATE))
        await phoenix.connections[0].close()
        await until(lambda: len(phoenix.joins) == 4 and socket.joined(STATE))
    assert len(phoenix.connections) == 2


async def test_heartbeats_are_answered_and_the_link_stays(
    phoenix: FakePhoenix, until: Until
) -> None:
    socket = socket_for(phoenix, heartbeat_s=0.01)
    async with running(socket):
        await until(lambda: phoenix.heartbeats >= 3)
        assert socket.health.up
    assert len(phoenix.connections) == 1


async def test_a_missed_heartbeat_reply_replaces_the_socket(
    phoenix: FakePhoenix, until: Until
) -> None:
    phoenix.answer_heartbeats = False
    socket = socket_for(phoenix, heartbeat_s=0.01, reply_timeout_s=0.05)
    async with running(socket):
        await until(lambda: len(phoenix.connections) >= 2)
    assert phoenix.connections[0].state.name == "CLOSED"


@pytest.mark.parametrize("event", ["phx_error", "phx_close"])
async def test_a_failed_channel_replaces_the_socket(
    event: str, phoenix: FakePhoenix, until: Until
) -> None:
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: socket.joined(STATE))
        await phoenix.push(f"realtime:{TELEMETRY}", event, {})
        await until(lambda: len(phoenix.connections) == 2 and socket.joined(STATE))


async def test_unrelated_frames_are_ignored(phoenix: FakePhoenix, until: Until) -> None:
    socket = socket_for(phoenix)
    async with running(socket):
        await until(lambda: socket.joined(STATE))
        await phoenix.push("realtime:org:other:soc:state", "phx_error", {})
        await phoenix.push(f"realtime:{TELEMETRY}", "presence_state", {})
        await phoenix.push(f"realtime:{TELEMETRY}", "system", {"status": "error", "message": "x"})
        await socket.send(Message(TELEMETRY, "sample", {}))
        await until(lambda: phoenix.broadcasts)
    assert len(phoenix.connections) == 1
