from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping

from aiohttp import web

from soc_supervision import Health

HealthSource = Callable[[], Health]


def report(service: str, links: Mapping[str, HealthSource]) -> tuple[bool, dict[str, object]]:
    now = time.monotonic()
    states = {name: source() for name, source in links.items()}
    ready = all(state.up for state in states.values())
    body: dict[str, object] = {
        "service": service,
        "ready": ready,
        "links": {
            name: {"up": state.up, "for_s": round(now - state.since, 1), "error": state.error}
            for name, state in states.items()
        },
    }
    return ready, body


def application(service: str, links: Mapping[str, HealthSource]) -> web.Application:
    async def health(_request: web.Request) -> web.Response:
        _, body = report(service, links)
        return web.json_response(body)

    async def ready(_request: web.Request) -> web.Response:
        is_ready, body = report(service, links)
        return web.json_response(body, status=200 if is_ready else 503)

    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/ready", ready)
    return app


async def serve(app: web.Application, port: int, host: str | None = None) -> None:
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        await web.TCPSite(runner, host, port).start()
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
