from __future__ import annotations

import asyncio
import copy
import json
import socket
from collections.abc import Callable
from typing import Any, cast

import aiomqtt
import pytest

import soc_config
from soc_cloud.link import topics
from soc_cloud.link.stack import FileOffer, StackLink
from soc_cloud.link.telemetry import Sample
from soc_cloud.settings import Api, Broker, Stack, StackCredentials
from soc_cloud.testing import FakeClient
from soc_cloud.wire import MQTT, WireContract
from soc_supervision import Backoff

WIRE = WireContract()
DOCK = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV001"
NOW_S = 1790800001.5
STACK = Stack(
    name="lab",
    broker=Broker(
        host="so-mosquitto",
        port=1883,
        username="cloud-client",
        password_env="SOC_MQTT_PASSWORD_LAB",
        client_id="cloud-client",
    ),
    api=Api(url="http://so-wayline:8081", token_env="SOC_SO_API_TOKEN_LAB"),
    flight_files_url="http://soc-cloud:8090",
)
CREDENTIALS = StackCredentials(
    broker_password=soc_config.Secret("b" * 40), api_token=soc_config.Secret("t" * 40)
)


def example(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((MQTT / "examples" / f"{name}.json").read_text())
    return loaded


class Harness:
    def __init__(self, files: Callable[[str], FileOffer | None] | None = None) -> None:
        self.samples: list[Sample] = []
        self.clients: list[FakeClient] = []
        self.down_reasons: list[str | None] = []
        self.link = StackLink(
            STACK,
            CREDENTIALS,
            WIRE,
            on_sample=self.samples.append,
            files=files or (lambda _flight: None),
            client_factory=self.client,
            backoff=Backoff(initial_s=0.001),
            sleep=self.back_off,
            clock=lambda: NOW_S,
        )

    async def back_off(self, _delay: float) -> None:
        self.down_reasons.append(self.link.health.error)
        await asyncio.sleep(0)

    def client(self, *arguments: Any, **options: Any) -> aiomqtt.Client:
        made = FakeClient(*arguments, **options)
        self.clients.append(made)
        return cast(aiomqtt.Client, made)

    async def receive(self, topic: str, message: dict[str, Any] | bytes) -> FakeClient:
        client = self.clients[-1] if self.clients else FakeClient()
        payload = message if isinstance(message, bytes) else json.dumps(message).encode()
        await self.link.receive(cast(aiomqtt.Client, client), topic, payload)
        return client


def dock_osd(online: int) -> dict[str, Any]:
    message = example("osd.dock")
    message["data"]["sub_device"]["device_online_status"] = online
    return message


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(1):
        while not condition():
            await asyncio.sleep(0.001)


def test_the_cloud_topics_are_read_and_nothing_else() -> None:
    assert topics.parse(f"sys/product/{DOCK}/status") == topics.Topic(topics.Inbound.STATUS, DOCK)
    assert topics.parse(f"thing/product/{AIRCRAFT}/osd") == topics.Topic(
        topics.Inbound.OSD, AIRCRAFT
    )
    assert topics.parse(f"thing/product/{DOCK}/property/set_reply") == topics.Topic(
        topics.Inbound.PROPERTY_SET_REPLY, DOCK
    )
    for ignored in (
        f"thing/product/{DOCK}/status",
        f"sys/product/{DOCK}/osd",
        f"thing/product/{DOCK}/services",
        "thing/product/bad-serial/osd",
        "so/internal/fleet/devices",
        "thing/product",
    ):
        assert topics.parse(ignored) is None, ignored


def test_the_subscriptions_cover_every_inbound_kind() -> None:
    assert topics.SUBSCRIPTIONS == (
        "sys/product/+/status",
        "thing/product/+/osd",
        "thing/product/+/state",
        "thing/product/+/events",
        "thing/product/+/requests",
        "thing/product/+/services_reply",
        "thing/product/+/property/set_reply",
    )


async def test_an_announcement_is_acknowledged_with_its_tid_and_bid() -> None:
    harness = Harness()
    announcement = example("sys.update_topo")
    client = await harness.receive(f"sys/product/{DOCK}/status", announcement)
    ((topic, reply),) = client.published
    assert topic == f"sys/product/{DOCK}/status_reply"
    assert reply == {
        "tid": announcement["tid"],
        "bid": announcement["bid"],
        "timestamp": int(NOW_S * 1000),
        "method": "update_topo",
        "data": {"result": 0},
    }


async def test_an_aircraft_is_online_only_while_listed_and_reported_online() -> None:
    harness = Harness()
    await harness.receive(f"thing/product/{DOCK}/osd", dock_osd(online=1))
    assert harness.link.topology.online() == set()
    await harness.receive(f"sys/product/{DOCK}/status", example("sys.update_topo"))
    assert harness.link.topology.online() == {AIRCRAFT}
    assert harness.link.topology.gateway_of(AIRCRAFT) == DOCK
    await harness.receive(f"thing/product/{DOCK}/osd", dock_osd(online=0))
    assert harness.link.topology.online() == set()


async def test_dropping_the_aircraft_from_the_topology_takes_it_offline() -> None:
    harness = Harness()
    await harness.receive(f"sys/product/{DOCK}/status", example("sys.update_topo"))
    await harness.receive(f"thing/product/{DOCK}/osd", dock_osd(online=1))
    empty = example("sys.update_topo")
    empty["data"]["sub_devices"] = []
    await harness.receive(f"sys/product/{DOCK}/status", empty)
    assert harness.link.topology.online() == set()
    assert harness.link.topology.gateway_of(AIRCRAFT) is None


async def test_an_aircraft_osd_is_one_sample_at_its_own_time() -> None:
    harness = Harness()
    osd = example("osd.aircraft")
    await harness.receive(f"thing/product/{AIRCRAFT}/osd", osd)
    (sample,) = harness.samples
    data = osd["data"]
    assert sample.stack == "lab"
    assert sample.gateway == DOCK
    assert sample.aircraft == AIRCRAFT
    assert sample.taken_at_ms == osd["timestamp"]
    assert sample.latitude_deg == data["latitude"]
    assert sample.longitude_deg == data["longitude"]
    assert sample.height_m == data["elevation"]
    assert sample.heading_deg == data["attitude_head"]
    assert sample.battery_pct == data["battery"]["capacity_percent"]
    assert sample.satellites == data["position_state"]["gps_number"]
    assert sample.gps_quality == data["position_state"]["quality"]


async def test_a_value_the_osd_lacks_is_unavailable_not_remembered() -> None:
    harness = Harness()
    first = example("osd.aircraft")
    second = copy.deepcopy(first)
    del second["data"]["battery"]
    del second["data"]["position_state"]
    await harness.receive(f"thing/product/{AIRCRAFT}/osd", first)
    await harness.receive(f"thing/product/{AIRCRAFT}/osd", second)
    assert harness.samples[0].battery_pct is not None
    assert harness.samples[1].battery_pct is None
    assert harness.samples[1].satellites is None
    assert harness.samples[1].latitude_deg == first["data"]["latitude"]


async def test_a_file_request_for_an_unknown_flight_is_refused_with_a_reason() -> None:
    harness = Harness()
    request = example("requests.flighttask_resource_get")
    client = await harness.receive(f"thing/product/{DOCK}/requests", request)
    ((topic, reply),) = client.published
    assert topic == f"thing/product/{DOCK}/requests_reply"
    assert (reply["tid"], reply["bid"]) == (request["tid"], request["bid"])
    assert reply["method"] == "flighttask_resource_get"
    assert reply["data"]["result"] != 0
    assert request["data"]["flight_id"] in reply["data"]["output"]


async def test_a_file_request_for_a_known_flight_gets_its_url_and_fingerprint() -> None:
    offer = FileOffer("http://soc-cloud:8090/files/abc.kmz", "0123456789abcdef0123456789abcdef")
    harness = Harness(files=lambda flight: offer if flight == "flight-1" else None)
    request = example("requests.flighttask_resource_get")
    request["data"]["flight_id"] = "flight-1"
    client = await harness.receive(f"thing/product/{DOCK}/requests", request)
    ((_, reply),) = client.published
    assert reply["data"] == {
        "result": 0,
        "output": {"file": {"url": offer.url, "fingerprint": offer.fingerprint}},
    }


async def test_a_reply_its_schema_refuses_is_not_sent() -> None:
    broken = FileOffer("http://soc-cloud:8090/files/abc.kmz", "not-a-fingerprint")
    harness = Harness(files=lambda _flight: broken)
    client = await harness.receive(
        f"thing/product/{DOCK}/requests", example("requests.flighttask_resource_get")
    )
    assert client.published == []


async def test_unreadable_and_unhandled_messages_are_dropped_quietly() -> None:
    harness = Harness()
    other_request = example("requests.flighttask_resource_get")
    other_request["method"] = "config"
    for topic, message in (
        (f"sys/product/{DOCK}/status", b"not json"),
        (f"thing/product/{AIRCRAFT}/osd", b'{"tid": "x"}'),
        (f"thing/product/{DOCK}/requests", other_request),
        (f"thing/product/{DOCK}/events", example("events.flighttask_progress")),
        ("so/internal/anything", {"x": 1}),
    ):
        client = await harness.receive(topic, message)
        assert client.published == []
    assert harness.samples == []


async def test_the_link_opens_a_persistent_v5_session_and_subscribes() -> None:
    harness = Harness()
    task = asyncio.create_task(harness.link.run())
    await until(lambda: harness.link.health.up)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (client,) = harness.clients
    assert client.arguments == ("so-mosquitto", 1883)
    assert client.options["username"] == "cloud-client"
    assert client.options["password"] == "b" * 40
    assert client.options["identifier"] == "cloud-client"
    assert client.options["protocol"] is aiomqtt.ProtocolVersion.V5
    assert client.options["clean_start"] is False
    assert client.options["properties"].SessionExpiryInterval == 3600
    assert client.options["socket_options"] == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
    assert client.subscriptions == list(topics.SUBSCRIPTIONS)
    assert client.closed


@pytest.mark.parametrize("end", ["take_over", "take_over_with_reason"])
async def test_a_taken_over_session_is_reported_and_taken_back(end: str) -> None:
    harness = Harness()
    task = asyncio.create_task(harness.link.run())
    await until(lambda: harness.link.health.up)
    getattr(harness.clients[0], end)()
    await until(lambda: len(harness.clients) == 2 and harness.link.health.up)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert harness.down_reasons == ["LinkDisplacedError: another cloud-client took the session"]
    assert harness.clients[0].closed


async def test_a_lost_broker_is_not_a_takeover() -> None:
    harness = Harness()
    task = asyncio.create_task(harness.link.run())
    await until(lambda: harness.link.health.up)
    harness.clients[0].lose()
    await until(lambda: len(harness.clients) == 2 and harness.link.health.up)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert harness.down_reasons == ["MqttError: Disconnected during message iteration"]
