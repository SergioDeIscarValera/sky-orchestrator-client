from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import aiohttp
import pytest
from aiohttp import web

from soc_realtime import Broadcaster, Endpoint, HttpBroadcast, Message, RealtimeSocket, Route
from soc_realtime.testing import FakePhoenix
from soc_supervision import Backoff

Until = Callable[..., Awaitable[None]]
KEY = ".".join(("h" * 20, "p" * 40, "s" * 43))
TELEMETRY = "org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:telemetry"


class FakeBroadcastApi:
    def __init__(self) -> None:
        self.requests: list[tuple[dict[str, str], dict[str, Any]]] = []
        self.status = 202
        self.port = 0

    async def handle(self, request: web.Request) -> web.Response:
        self.requests.append((dict(request.headers), json.loads(await request.read())))
        return web.Response(status=self.status, text="" if self.status < 300 else "tenant limit")


@pytest.fixture
async def api() -> AsyncIterator[FakeBroadcastApi]:
    fake = FakeBroadcastApi()
    application = web.Application()
    application.router.add_post("/api/broadcast", fake.handle)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.port = runner.addresses[0][1]
    try:
        yield fake
    finally:
        await runner.cleanup()


@pytest.fixture
async def session() -> AsyncIterator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession() as client:
        yield client


def http_for(port: int, session: aiohttp.ClientSession, timeout_s: float = 5.0) -> HttpBroadcast:
    return HttpBroadcast(Endpoint(f"http://127.0.0.1:{port}/socket", KEY), session, timeout_s)


async def test_a_batch_is_posted_as_private_messages_with_the_key(
    api: FakeBroadcastApi, session: aiohttp.ClientSession
) -> None:
    messages = [Message(TELEMETRY, "sample", {"n": 1}), Message(TELEMETRY, "sample", {"n": 2})]
    assert await http_for(api.port, session).send(messages)
    ((headers, body),) = api.requests
    assert headers["apikey"] == KEY
    assert headers["Authorization"] == f"Bearer {KEY}"
    assert body == {
        "messages": [
            {"topic": TELEMETRY, "event": "sample", "payload": {"n": 1}, "private": True},
            {"topic": TELEMETRY, "event": "sample", "payload": {"n": 2}, "private": True},
        ]
    }


async def test_a_refused_batch_is_reported(
    api: FakeBroadcastApi, session: aiohttp.ClientSession
) -> None:
    api.status = 429
    assert not await http_for(api.port, session).send([Message(TELEMETRY, "sample", {})])


async def test_an_unreachable_api_is_reported(session: aiohttp.ClientSession) -> None:
    with_nobody = http_for(9, session, timeout_s=0.5)
    assert not await with_nobody.send([Message(TELEMETRY, "sample", {})])


async def test_the_socket_carries_messages_while_joined_and_http_otherwise(
    api: FakeBroadcastApi, session: aiohttp.ClientSession, until: Until
) -> None:
    async with FakePhoenix().serving() as phoenix:
        socket = RealtimeSocket(
            Endpoint(phoenix.base, KEY), [TELEMETRY], backoff=Backoff(initial_s=0.01)
        )
        broadcaster = Broadcaster(socket, http_for(api.port, session))

        assert await broadcaster.send([Message(TELEMETRY, "sample", {"n": 0})]) is Route.HTTP

        task = asyncio.create_task(socket.run())
        await until(lambda: socket.joined(TELEMETRY))
        batch = [Message(TELEMETRY, "sample", {"n": n}) for n in (1, 2)]
        assert await broadcaster.send(batch) is Route.SOCKET
        await until(lambda: len(phoenix.broadcasts) == 2)

        api.status = 500
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await broadcaster.send([Message(TELEMETRY, "sample", {"n": 3})]) is Route.DROPPED

    assert len(api.requests) == 2
    assert broadcaster.counts == {Route.HTTP: 1, Route.SOCKET: 2, Route.DROPPED: 1}
