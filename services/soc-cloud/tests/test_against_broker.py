from __future__ import annotations

import asyncio
import contextlib
import json
import statistics
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import aiomqtt
import pytest

import soc_config
from soc_cloud.link.stack import StackLink
from soc_cloud.link.telemetry import Sample
from soc_cloud.settings import Api, Broker, Stack, StackCredentials
from soc_cloud.testing import CLOUD_CLIENT, EphemeralMosquitto
from soc_cloud.wire import MQTT, WireContract
from soc_supervision import Backoff

pytestmark = pytest.mark.lane

WIRE = WireContract()
DOCK = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV001"


def example(name: str, **changes: Any) -> dict[str, Any]:
    message: dict[str, Any] = json.loads((MQTT / "examples" / f"{name}.json").read_text())
    return {**message, "tid": str(uuid.uuid4()), **changes}


class Cloud:
    def __init__(self, broker: EphemeralMosquitto) -> None:
        self.samples: list[Sample] = []
        self.down_reasons: list[str | None] = []
        stack = Stack(
            name="lab",
            broker=Broker(
                host="127.0.0.1",
                port=broker.port,
                username=CLOUD_CLIENT,
                password_env="SOC_MQTT_PASSWORD_LAB",
                client_id=CLOUD_CLIENT,
            ),
            api=Api(url="http://127.0.0.1:9", token_env="SOC_SO_API_TOKEN_LAB"),
            flight_files_url="http://127.0.0.1:9",
        )
        credentials = StackCredentials(
            broker_password=soc_config.Secret(broker.cloud_password),
            api_token=soc_config.Secret("t" * 40),
        )
        self.link = StackLink(
            stack,
            credentials,
            WIRE,
            on_sample=self.samples.append,
            backoff=Backoff(initial_s=0.1),
            sleep=self.back_off,
        )

    async def back_off(self, delay: float) -> None:
        self.down_reasons.append(self.link.health.error)
        await asyncio.sleep(delay)


async def until(condition: Callable[[], bool], within_s: float = 5.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.01)


@asynccontextmanager
async def running(cloud: Cloud) -> AsyncIterator[Cloud]:
    task = asyncio.create_task(cloud.link.run())
    try:
        await until(lambda: cloud.link.health.up)
        await asyncio.sleep(0.2)
        yield cloud
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@asynccontextmanager
async def dock_side(broker: EphemeralMosquitto, *replies: str) -> AsyncIterator[aiomqtt.Client]:
    async with broker.dock() as dock:
        for topic in replies:
            await dock.subscribe(topic, qos=1)
        yield dock


async def reply_to(dock: aiomqtt.Client, tid: str, within_s: float = 5.0) -> dict[str, Any]:
    async with asyncio.timeout(within_s):
        async for message in dock.messages:
            assert isinstance(message.payload, bytes)
            reply: dict[str, Any] = json.loads(message.payload)
            if reply["tid"] == tid:
                return reply
    raise AssertionError("unreachable")


async def announce(dock: aiomqtt.Client, **changes: Any) -> dict[str, Any]:
    announcement = example("sys.update_topo", **changes)
    await dock.publish(f"sys/product/{DOCK}/status", json.dumps(announcement), qos=1)
    return announcement


async def test_an_announcement_is_acknowledged_and_presence_followed(
    broker: EphemeralMosquitto,
) -> None:
    async with (
        running(Cloud(broker)) as cloud,
        dock_side(broker, f"sys/product/{DOCK}/status_reply") as dock,
    ):
        announcement = await announce(dock)
        reply = await reply_to(dock, announcement["tid"])
        osd = example("osd.dock")
        await dock.publish(f"thing/product/{DOCK}/osd", json.dumps(osd), qos=0)
        await until(lambda: cloud.link.topology.online() == {AIRCRAFT})
    assert reply["data"] == {"result": 0}
    assert reply["bid"] == announcement["bid"]


async def test_aircraft_osd_becomes_samples(broker: EphemeralMosquitto) -> None:
    async with running(Cloud(broker)) as cloud, dock_side(broker) as dock:
        complete = example("osd.aircraft")
        partial = example("osd.aircraft")
        partial["data"] = {key: value for key, value in partial["data"].items() if key != "battery"}
        for osd in (complete, partial):
            await dock.publish(f"thing/product/{AIRCRAFT}/osd", json.dumps(osd), qos=0)
        await until(lambda: len(cloud.samples) == 2)
    assert cloud.samples[0].battery_pct is not None
    assert cloud.samples[1].battery_pct is None
    assert cloud.samples[1].taken_at_ms == partial["timestamp"]


async def test_file_requests_are_answered_within_half_a_second_at_p99(
    broker: EphemeralMosquitto,
) -> None:
    latencies: list[float] = []
    async with (
        running(Cloud(broker)),
        dock_side(broker, f"thing/product/{DOCK}/requests_reply") as dock,
    ):
        for _ in range(100):
            request = example("requests.flighttask_resource_get")
            sent = time.perf_counter()
            await dock.publish(f"thing/product/{DOCK}/requests", json.dumps(request), qos=1)
            reply = await reply_to(dock, request["tid"])
            latencies.append(time.perf_counter() - sent)
            assert reply["data"]["result"] != 0
    assert statistics.quantiles(latencies, n=100)[98] < 0.5


async def test_what_the_dock_sends_while_soc_is_away_waits_in_its_session(
    broker: EphemeralMosquitto,
) -> None:
    async with running(Cloud(broker)):
        pass
    async with dock_side(broker, f"sys/product/{DOCK}/status_reply") as dock:
        announcement = await announce(dock)
        async with running(Cloud(broker)):
            reply = await reply_to(dock, announcement["tid"])
    assert reply["data"] == {"result": 0}


async def test_the_link_returns_after_the_broker_restarts(broker: EphemeralMosquitto) -> None:
    async with running(Cloud(broker)) as cloud:
        up_since = cloud.link.health.since
        await asyncio.to_thread(broker.restart)
        await until(
            lambda: cloud.link.health.up and cloud.link.health.since > up_since, within_s=15
        )
        async with dock_side(broker, f"sys/product/{DOCK}/status_reply") as dock:
            announcement = await announce(dock)
            reply = await reply_to(dock, announcement["tid"])
    assert reply["data"] == {"result": 0}


async def test_a_takeover_of_the_session_is_reported(broker: EphemeralMosquitto) -> None:
    async with running(Cloud(broker)) as cloud:
        with contextlib.suppress(aiomqtt.MqttError):
            async with broker.intruder():
                await until(lambda: bool(cloud.down_reasons))
    assert cloud.down_reasons[0] == "LinkDisplacedError: another cloud-client took the session"
