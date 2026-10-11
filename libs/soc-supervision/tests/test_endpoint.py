from __future__ import annotations

import asyncio
import socket
import time
from collections.abc import AsyncIterator

import aiohttp
import pytest
from aiohttp import web

from soc_supervision import Health
from soc_supervision.endpoint import HealthSource, application, serve

UP = Health(up=True, since=time.monotonic() - 12.0)
DOWN = Health(up=False, since=time.monotonic() - 3.0, error="OSError: connection refused")


@pytest.fixture
async def served() -> AsyncIterator[tuple[dict[str, Health], str]]:
    states = {"database": UP, "realtime": UP}

    def source(name: str) -> HealthSource:
        return lambda: states[name]

    app = application("soc-cloud", {name: source(name) for name in states})
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield states, f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


async def get(url: str) -> tuple[int, dict[str, object]]:
    async with aiohttp.ClientSession() as session, session.get(url) as response:
        return response.status, await response.json()


async def test_health_reports_every_link(served: tuple[dict[str, Health], str]) -> None:
    states, base = served
    states["realtime"] = DOWN
    status, body = await get(f"{base}/health")
    assert status == 200
    assert body["service"] == "soc-cloud"
    assert body["ready"] is False
    links = body["links"]
    assert isinstance(links, dict)
    assert links["database"]["up"] is True
    assert links["database"]["for_s"] >= 12.0
    assert links["realtime"] == {
        "up": False,
        "for_s": links["realtime"]["for_s"],
        "error": "OSError: connection refused",
    }


async def test_ready_answers_200_only_while_every_link_is_up(
    served: tuple[dict[str, Health], str],
) -> None:
    states, base = served
    assert (await get(f"{base}/ready"))[0] == 200
    states["database"] = DOWN
    assert (await get(f"{base}/ready"))[0] == 503


async def test_serve_answers_until_cancelled() -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    task = asyncio.create_task(
        serve(application("soc-cloud", {"x": lambda: UP}), port, "127.0.0.1")
    )
    async with asyncio.timeout(5):
        while True:
            try:
                status, _ = await get(f"http://127.0.0.1:{port}/ready")
                break
            except aiohttp.ClientConnectionError:
                await asyncio.sleep(0.01)
    assert status == 200
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
