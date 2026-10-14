"""Sky Orchestrator's released stack, brought up from the vendored files (soc_e2e.so_stack).

The stack comes up ready to fly in simulator mode with the fake bridge, turns to real mode
and back, lets SOC's cloud-client hear its dock announce, and reaches a server on its
network's gateway, where soc-cloud serves the flight files. Its own project, ports and
credentials: no other stack on the machine is touched.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from typing import Any

import aiomqtt
import pytest
from aiohttp import web

from soc_e2e.so_stack import PROJECT_PREFIX, Site, SoStack

pytestmark = [pytest.mark.lane, pytest.mark.sky_orchestrator]

FARM = Site(latitude_deg=41.6523, longitude_deg=-4.7245)


@pytest.fixture(scope="module")
def so_stack() -> Iterator[SoStack]:
    stack = SoStack(site=FARM)
    try:
        stack.start()
        yield stack
    except BaseException:
        print(stack.logs())
        raise
    finally:
        stack.stop()


def test_the_stack_is_its_own_and_ready_to_fly_in_simulator_mode(so_stack: SoStack) -> None:
    assert so_stack.project.startswith(PROJECT_PREFIX)
    assert set(so_stack.services()) == {
        "mosquitto", "so-wayline", "so-bridge", "so-fleet", "so-gateway", "fake-bridge",
    }  # fmt: skip
    status = so_stack.status()
    assert status is not None
    assert (status["link"]["state"], status["armed"], status["aircraft_online"]) == (
        "up",
        True,
        True,
    )
    assert (status["simulator_mode"], status["simulator_active"]) == (True, True)


def test_the_stack_turns_to_real_mode_and_back(so_stack: SoStack) -> None:
    real = so_stack.set_simulator_mode(False)
    assert real["simulator_mode"] is False
    # The fake bridge launched in its simulator keeps it on: PF-SIMULATOR names it.
    assert real["simulator_active"] is True
    simulated = so_stack.set_simulator_mode(True)
    assert simulated["simulator_mode"] is True


def test_the_fake_bridge_launches_as_a_phone_ready_for_real_flight_and_back(
    so_stack: SoStack,
) -> None:
    try:
        real = so_stack.set_real_launch(True)
        assert (real["simulator_mode"], real["simulator_active"]) == (False, False)
        assert (real["armed"], real["aircraft_online"]) == (True, True)
    finally:
        simulated = so_stack.set_real_launch(False)
    assert (simulated["simulator_mode"], simulated["simulator_active"]) == (True, True)


async def test_the_cloud_client_hears_the_dock_announce_its_aircraft(so_stack: SoStack) -> None:
    async with aiomqtt.Client(
        "127.0.0.1",
        so_stack.mqtt_port,
        username="cloud-client",
        password=so_stack.cloud_password,
        protocol=aiomqtt.ProtocolVersion.V5,
    ) as client:
        await client.subscribe("sys/product/+/status", qos=1)
        async with asyncio.timeout(20):
            async for message in client.messages:
                assert isinstance(message.payload, bytes)
                announced: dict[str, Any] = json.loads(message.payload)
                if announced.get("method") == "update_topo":
                    break
    assert str(message.topic) == f"sys/product/{so_stack.dock_sn}/status"
    assert [device["sn"] for device in announced["data"]["sub_devices"]] == [so_stack.aircraft_sn]


async def test_so_wayline_reaches_a_server_on_the_networks_gateway(so_stack: SoStack) -> None:
    app = web.Application()

    async def probe(_request: web.Request) -> web.Response:
        return web.Response(text="reached")

    app.router.add_get("/probe", probe)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, so_stack.gateway, 0)
    await site.start()
    try:
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        fetched = await asyncio.to_thread(
            so_stack.compose,
            "exec", "-T", "so-wayline", "python", "-c",
            "import sys, urllib.request; "
            "print(urllib.request.urlopen(sys.argv[1], timeout=5).read().decode())",
            f"http://{so_stack.gateway}:{port}/probe",
        )  # fmt: skip
    finally:
        await runner.cleanup()
    assert fetched.stdout.strip() == "reached"
