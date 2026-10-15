"""Sky Orchestrator refuses, by itself, a real prepare of a file never simulated on it (NFR-SAF-05).

SOC never sends one: soc-operations asks a real prepare only for a file whose simulation ended ok
(test_operation_against_so). This holds Sky Orchestrator's own gate behind SOC's (its NFR-SAF-07):
the stack in real mode with the phone ready for real flight, a valid flight file served where
so-wayline fetches it, and a real prepare published straight onto the dock's services topic, as
a cloud that skipped the simulation would. Sky Orchestrator answers 314010, names its reason, and
prepares nothing.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import aiomqtt
import pytest
from aiohttp import web

from soc_e2e.so_stack import Site, SoStack
from soc_operations import flight_files
from soc_operations.testing import FLIGHT

pytestmark = [pytest.mark.lane, pytest.mark.sky_orchestrator]

FARM = Site(latitude_deg=41.6523, longitude_deg=-4.7245)
#: DJI's "Unable to perform task.", Sky Orchestrator's answer to a real prepare of a file never
#: simulated on it (its ADR-0037).
NEVER_SIMULATED = 314010
REPLY_WITHIN_S = 30


@pytest.fixture(scope="module")
def so_stack() -> Iterator[SoStack]:
    stack = SoStack(site=FARM)
    try:
        stack.start()
        stack.set_real_launch(True)
        yield stack
    except BaseException:
        print(stack.logs())
        raise
    finally:
        stack.stop()


@pytest.fixture
async def served(so_stack: SoStack) -> AsyncIterator[tuple[str, str]]:
    """The flight file on the stack network's gateway, where so-wayline fetches: its URL and MD5."""
    kmz = flight_files.build(FLIGHT, name="Never simulated")
    app = web.Application()

    async def file(_request: web.Request) -> web.Response:
        return web.Response(body=kmz, content_type="application/vnd.google-earth.kmz")

    app.router.add_get("/files/never-simulated.kmz", file)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, so_stack.gateway, 0)
    await site.start()
    try:
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        yield (
            f"http://{so_stack.gateway}:{port}/files/never-simulated.kmz",
            flight_files.fingerprint(kmz),
        )
    finally:
        await runner.cleanup()


def real_prepare(flight_id: str, url: str, md5: str) -> dict[str, Any]:
    """A real prepare as soc-operations words one (its lifecycle's _prepare_payload)."""
    takeoff = FLIGHT["reference_point"]
    return {
        "tid": str(uuid.uuid4()),
        "bid": flight_id,
        "timestamp": int(time.time() * 1000),
        "method": "flighttask_prepare",
        "data": {
            "flight_id": flight_id,
            "task_type": 0,
            "wayline_type": 0,
            "file": {"url": url, "fingerprint": md5},
            "rth_altitude": 20,
            "out_of_control_action": 0,
            "exit_wayline_when_rc_lost": 0,
            "simulate_mission": {"is_enable": 0, "latitude": takeoff[1], "longitude": takeoff[0]},
        },
    }


async def test_a_real_prepare_of_a_file_never_simulated_is_refused_by_sky_orchestrator(
    so_stack: SoStack, served: tuple[str, str]
) -> None:
    url, md5 = served
    flight_id = str(uuid.uuid4())
    asked = real_prepare(flight_id, url, md5)
    async with aiomqtt.Client(
        "127.0.0.1",
        so_stack.mqtt_port,
        username="cloud-client",
        password=so_stack.cloud_password,
        protocol=aiomqtt.ProtocolVersion.V5,
    ) as client:
        await client.subscribe(f"thing/product/{so_stack.dock_sn}/services_reply", qos=1)
        await client.publish(f"thing/product/{so_stack.dock_sn}/services", json.dumps(asked), qos=1)
        async with asyncio.timeout(REPLY_WITHIN_S):
            async for message in client.messages:
                assert isinstance(message.payload, bytes)
                reply: dict[str, Any] = json.loads(message.payload)
                if reply.get("tid") == asked["tid"]:
                    break
    assert reply["method"] == "flighttask_prepare"
    assert reply["data"]["result"] == NEVER_SIMULATED
    # The result is shared with two other refusals of a prepare; Sky Orchestrator's fleet names
    # this one: the file has never completed in simulator mode on this deployment.
    fleet = so_stack.compose("logs", "--no-color", "so-fleet").stdout
    assert "not_flown_in_simulation" in fleet
    assert md5 in fleet
