from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import aiomqtt
import pytest
from structlog.testing import capture_logs

import soc_config
from soc_cloud.commands import Commands, Intent
from soc_cloud.latency import Latencies
from soc_cloud.link.stack import StackLink
from soc_cloud.settings import Api, Broker, Stack, StackCredentials
from soc_cloud.testing import FakeClient
from soc_cloud.wire import MQTT, WireContract
from soc_supervision import Backoff

WIRE = WireContract()
DOCK = "SOTESTDOCK01"
TTL_S = 10
REPLY_TIMEOUT_S = 0.2
STACK = Stack(
    name="lab",
    organization=uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"),
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


def now() -> datetime:
    return datetime.now(UTC)


class FakeStore:
    """soc.command_intents and soc-cloud's four functions, in memory."""

    def __init__(self) -> None:
        self.rows: dict[uuid.UUID, Intent] = {}
        self.results: dict[uuid.UUID, int] = {}

    def request(
        self,
        verb: str = "return_home",
        payload: dict[str, Any] | None = None,
        gateway: str = DOCK,
        age_s: float = 0.0,
    ) -> uuid.UUID:
        intent = Intent(
            id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            operation_id=uuid.uuid4(),
            flight_id=uuid.uuid4(),
            gateway_sn=gateway,
            verb=verb,
            payload=payload or {},
            status="pending",
            requested_at=now() - timedelta(seconds=age_s),
            sent_at=None,
        )
        self.rows[intent.id] = intent
        return intent.id

    def mark_sent(self, intent: uuid.UUID, seconds_ago: float) -> None:
        row = self.rows[intent]
        sent_at = now() - timedelta(seconds=seconds_ago)
        self.rows[intent] = Intent(**{**_fields(row), "status": "sent", "sent_at": sent_at})

    def status(self, intent: uuid.UUID) -> str:
        return self.rows[intent].status

    async def pending(self) -> list[uuid.UUID]:
        return [row.id for row in self.rows.values() if row.status == "pending"]

    async def awaiting_reply(self) -> list[Intent]:
        return [row for row in self.rows.values() if row.status == "sent"]

    async def get(self, intent: uuid.UUID) -> Intent | None:
        return self.rows.get(intent)

    async def claim(self, intent: uuid.UUID, ttl_s: int) -> Intent | None:
        row = self.rows.get(intent)
        if row is None or row.status != "pending":
            return None
        late = now() - row.requested_at > timedelta(seconds=ttl_s)
        return self._move(row, "expired" if late else "sent", sent_at=None if late else now())

    async def fail(self, intent: uuid.UUID) -> Intent | None:
        row = self.rows.get(intent)
        return self._move(row, "failed") if row and row.status == "pending" else None

    async def record_reply(self, intent: uuid.UUID, result: int) -> Intent | None:
        row = self.rows.get(intent)
        if row is None or row.status != "sent":
            return None
        self.results[intent] = result
        return self._move(row, "accepted" if result == 0 else "refused")

    async def time_out(self, intent: uuid.UUID) -> Intent | None:
        row = self.rows.get(intent)
        return self._move(row, "timed_out") if row and row.status == "sent" else None

    def _move(self, row: Intent, status: str, **changes: Any) -> Intent:
        moved = Intent(**{**_fields(row), "status": status, **changes})
        self.rows[row.id] = moved
        return moved


def _fields(row: Intent) -> dict[str, Any]:
    return {field: getattr(row, field) for field in Intent.__struct_fields__}


class Cloud:
    def __init__(self, ttl_s: int = TTL_S) -> None:
        self.store = FakeStore()
        self.files_kept: list[uuid.UUID] = []
        self.keeps_files = True
        self.settled: list[tuple[str, str, int]] = []
        self.clients: list[FakeClient] = []
        self.link = StackLink(
            STACK,
            CREDENTIALS,
            WIRE,
            on_sample=lambda _sample: None,
            on_reply=lambda tid, result: self.commands.replied(tid, result),
            on_announced=lambda gateway: self.commands.announced_gateway(gateway),
            client_factory=self._client,
            backoff=Backoff(initial_s=0.001),
        )
        self.latencies = Latencies()
        self.commands = Commands(
            self.store,
            [self.link],
            WIRE,
            ttl_s=ttl_s,
            reply_timeout_s=REPLY_TIMEOUT_S,
            latencies=self.latencies,
            on_prepare=self._keep_file,
            on_settled=lambda intent, result: self.settled.append(
                (intent.verb, intent.status, result)
            ),
        )

    async def _keep_file(self, intent: Intent) -> bool:
        # What the flights' watch does: the file is kept before the prepare goes out.
        assert self.services() == []
        self.files_kept.append(intent.id)
        return self.keeps_files

    def _client(self, *arguments: Any, **options: Any) -> aiomqtt.Client:
        made = FakeClient(*arguments, **options)
        self.clients.append(made)
        return cast(aiomqtt.Client, made)

    @property
    def client(self) -> FakeClient:
        return self.clients[-1]

    def services(self) -> list[dict[str, Any]]:
        return [message for topic, message in self.client.published if topic.endswith("/services")]

    def reply(self, intent: uuid.UUID, result: int, flight: uuid.UUID | None = None) -> None:
        self.client.deliver(
            f"thing/product/{DOCK}/services_reply",
            {
                "tid": str(intent),
                "bid": str(flight or self.store.rows[intent].flight_id),
                "timestamp": int(time.time() * 1000),
                "method": "return_home",
                "data": {"result": result},
            },
        )


async def until(condition: Callable[[], bool], within_s: float = 2.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.002)


def announce(cloud: Cloud) -> None:
    announcement = json.loads((MQTT / "examples" / "sys.update_topo.json").read_text())
    cloud.client.deliver(f"sys/product/{DOCK}/status", announcement)


@asynccontextmanager
async def connected(ttl_s: int = TTL_S, announced: bool = True) -> AsyncIterator[Cloud]:
    cloud = Cloud(ttl_s)
    task = asyncio.create_task(cloud.link.run())
    try:
        await until(lambda: cloud.link.health.up)
        if announced:
            announce(cloud)
            await until(lambda: cloud.link.serves(DOCK))
        yield cloud
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_a_command_is_published_with_its_tid_and_bid() -> None:
    async with connected() as cloud:
        intent = cloud.store.request(verb="pause")
        await cloud.commands.announced(str(intent))
        ((message),) = cloud.services()
        topic = cloud.client.published[-1][0]
    row = cloud.store.rows[intent]
    assert topic == f"thing/product/{DOCK}/services"
    assert message["tid"] == str(intent)
    assert message["bid"] == str(row.flight_id)
    assert message["method"] == "flighttask_pause"
    assert message["data"] == {}
    assert row.status == "sent"


async def test_an_intent_announced_three_times_runs_once() -> None:
    async with connected() as cloud:
        intent = cloud.store.request()
        for _ in range(3):
            await cloud.commands.announced(str(intent))
        assert len(cloud.services()) == 1


async def test_a_reply_settles_the_command_and_stops_its_clock() -> None:
    async with connected() as cloud:
        accepted, refused = cloud.store.request(), cloud.store.request()
        for intent in (accepted, refused):
            await cloud.commands.announced(str(intent))
        cloud.reply(accepted, 0)
        cloud.reply(refused, 314010)
        await until(lambda: cloud.store.status(refused) == "refused")
        await asyncio.sleep(REPLY_TIMEOUT_S * 2)
    assert cloud.store.status(accepted) == "accepted"
    assert cloud.store.results == {accepted: 0, refused: 314010}
    timed = cloud.latencies.summary()
    assert timed["command_publish_ms"]["count"] == 2
    assert timed["command_reply_ms"]["count"] == 2


async def test_a_command_that_times_out_has_no_reply_latency() -> None:
    async with connected() as cloud:
        intent = cloud.store.request()
        await cloud.commands.announced(str(intent))
        await until(lambda: cloud.store.status(intent) == "timed_out")
        cloud.reply(intent, 0)
        await asyncio.sleep(0.01)
    assert "command_reply_ms" not in cloud.latencies.summary()


async def test_a_command_with_no_reply_times_out() -> None:
    async with connected() as cloud:
        intent = cloud.store.request()
        await cloud.commands.announced(str(intent))
        await until(lambda: cloud.store.status(intent) == "timed_out")


async def test_a_late_command_expires_instead_of_running() -> None:
    async with connected() as cloud:
        intent = cloud.store.request(age_s=TTL_S + 1)
        await cloud.commands.announced(str(intent))
        assert cloud.services() == []
    assert cloud.store.status(intent) == "expired"


async def test_a_command_its_schema_refuses_fails_before_sending() -> None:
    async with connected() as cloud:
        intent = cloud.store.request(verb="prepare", payload={"flight_id": "x"})
        await cloud.commands.announced(str(intent))
        assert cloud.services() == []
    assert cloud.store.status(intent) == "failed"


async def test_a_command_waits_for_its_dock_and_runs_when_it_is_announced() -> None:
    async with connected(announced=False) as cloud:
        intent = cloud.store.request()
        await cloud.commands.announced(str(intent))
        assert cloud.services() == []
        assert cloud.store.status(intent) == "pending"
        announce(cloud)
        await until(lambda: len(cloud.services()) == 1)
    assert cloud.store.status(intent) == "sent"


async def test_a_command_whose_dock_never_appears_expires() -> None:
    async with connected(ttl_s=0) as cloud:
        intent = cloud.store.request(gateway="UNKNOWNDOCK1")
        await cloud.commands.announced(str(intent))
        await until(lambda: cloud.store.status(intent) == "expired")
        assert cloud.services() == []


async def test_a_command_claimed_while_the_link_drops_times_out() -> None:
    async with connected() as cloud:
        intent = cloud.store.request()
        cloud.client.publish_error = aiomqtt.MqttError("The connection was lost.")
        await cloud.commands.announced(str(intent))
        assert cloud.store.status(intent) == "sent"
        await until(lambda: cloud.store.status(intent) == "timed_out")


async def test_the_sweep_runs_what_was_missed_and_settles_what_was_left_sent() -> None:
    async with connected() as cloud:
        first, second = cloud.store.request(), cloud.store.request()
        overdue, recent = cloud.store.request(), cloud.store.request()
        cloud.store.mark_sent(overdue, seconds_ago=REPLY_TIMEOUT_S * 10)
        cloud.store.mark_sent(recent, seconds_ago=0)
        await cloud.commands.sweep()
        assert [message["tid"] for message in cloud.services()] == [str(first), str(second)]
        cloud.reply(recent, 0)
        await until(lambda: cloud.store.status(overdue) == "timed_out")
        await until(lambda: cloud.store.status(recent) == "accepted")


async def test_an_unreadable_announcement_is_ignored() -> None:
    async with connected() as cloud:
        await cloud.commands.announced("not-a-uuid")
        assert cloud.services() == []


PREPARE = {
    "flight_id": "3f0e3a2c-1b7d-4c55-9b8e-2a6f1c4d5e60",
    "task_type": 0,
    "wayline_type": 0,
    "file": {"url": "http://soc-cloud:8090/files/" + "0f" * 16 + ".kmz", "fingerprint": "a" * 32},
    "rth_altitude": 20,
    "out_of_control_action": 0,
    "exit_wayline_when_rc_lost": 0,
    "simulate_mission": {"is_enable": 1, "latitude": 41.6523, "longitude": -4.7245},
}


async def test_a_prepare_goes_out_once_its_flights_file_is_kept() -> None:
    async with connected() as cloud:
        intent = cloud.store.request(verb="prepare", payload=PREPARE)
        await cloud.commands.announced(str(intent))
        ((message),) = cloud.services()
    assert cloud.files_kept == [intent]
    assert message["method"] == "flighttask_prepare"
    assert cloud.store.status(intent) == "sent"


async def test_a_prepare_whose_file_cannot_be_kept_fails_before_the_wire() -> None:
    async with connected() as cloud:
        cloud.keeps_files = False
        intent = cloud.store.request(verb="prepare", payload=PREPARE)
        await cloud.commands.announced(str(intent))
        assert cloud.services() == []
    assert cloud.store.status(intent) == "failed"


async def test_only_a_prepare_waits_for_a_file() -> None:
    async with connected() as cloud:
        await cloud.commands.announced(str(cloud.store.request(verb="pause")))
    assert cloud.files_kept == []


async def test_each_reply_recorded_is_reported_as_settled() -> None:
    async with connected() as cloud:
        accepted, refused = cloud.store.request(verb="pause"), cloud.store.request()
        for intent in (accepted, refused):
            await cloud.commands.announced(str(intent))
        cloud.reply(accepted, 0)
        cloud.reply(refused, 314010)
        await until(lambda: len(cloud.settled) == 2)
        cloud.reply(accepted, 0)
        await asyncio.sleep(0.01)
    assert sorted(cloud.settled) == [("pause", "accepted", 0), ("return_home", "refused", 314010)]


def sent_by_soc_cloud(cloud: Cloud, intent: uuid.UUID, flight: uuid.UUID) -> None:
    """The intent as soc.record_geofence_breach inserts it: already sent."""
    cloud.store.rows[intent] = Intent(
        id=intent,
        organization_id=uuid.uuid4(),
        operation_id=uuid.uuid4(),
        flight_id=flight,
        gateway_sn=DOCK,
        verb="return_home",
        payload={},
        status="sent",
        requested_at=now(),
        sent_at=now(),
    )


async def test_send_now_puts_the_return_on_the_wire_before_any_record() -> None:
    flight = uuid.uuid4()
    async with connected() as cloud:
        intent = await cloud.commands.send_now(DOCK, flight, "return_home")
        ((message),) = cloud.services()
    assert intent is not None
    assert cloud.store.rows == {}
    assert message["tid"] == str(intent)
    assert message["bid"] == str(flight)
    assert (message["method"], message["data"]) == ("return_home", {})


async def test_a_reply_heard_before_the_record_settles_it_once_recorded() -> None:
    flight = uuid.uuid4()
    async with connected() as cloud:
        intent = await cloud.commands.send_now(DOCK, flight, "return_home")
        assert intent is not None
        cloud.reply(intent, 0, flight)
        cloud.reply(intent, 1, flight)
        await asyncio.sleep(0.01)
        sent_by_soc_cloud(cloud, intent, flight)
        assert cloud.store.status(intent) == "sent"
        cloud.commands.recorded(intent, kept=True)
        await until(lambda: cloud.store.status(intent) == "accepted")
        await asyncio.sleep(REPLY_TIMEOUT_S * 2)
    assert cloud.store.results == {intent: 0}
    assert cloud.settled == [("return_home", "accepted", 0)]
    assert cloud.latencies.summary()["command_reply_ms"]["count"] == 1


async def test_a_reply_after_the_record_settles_it_as_any_other() -> None:
    flight = uuid.uuid4()
    async with connected() as cloud:
        intent = await cloud.commands.send_now(DOCK, flight, "return_home")
        assert intent is not None
        sent_by_soc_cloud(cloud, intent, flight)
        cloud.commands.recorded(intent, kept=True)
        cloud.reply(intent, 0, flight)
        await until(lambda: cloud.store.status(intent) == "accepted")


async def test_a_return_recorded_with_no_reply_times_out_from_when_it_was_sent() -> None:
    flight = uuid.uuid4()
    async with connected() as cloud:
        intent = await cloud.commands.send_now(DOCK, flight, "return_home")
        assert intent is not None
        await asyncio.sleep(REPLY_TIMEOUT_S * 0.75)
        sent_by_soc_cloud(cloud, intent, flight)
        cloud.commands.recorded(intent, kept=True)
        await asyncio.sleep(REPLY_TIMEOUT_S * 0.5)
        assert cloud.store.status(intent) == "timed_out"


async def test_a_return_never_recorded_lets_its_reply_go() -> None:
    flight = uuid.uuid4()
    async with connected() as cloud:
        intent = await cloud.commands.send_now(DOCK, flight, "return_home")
        assert intent is not None
        cloud.reply(intent, 0, flight)
        await asyncio.sleep(0.01)
        cloud.commands.recorded(intent, kept=False)
        await asyncio.sleep(REPLY_TIMEOUT_S * 2)
    assert cloud.store.results == {}
    assert cloud.settled == []


async def test_send_now_names_why_nothing_went_out() -> None:
    async with connected(announced=False) as cloud:
        with capture_logs() as logs:
            unserved = await cloud.commands.send_now(DOCK, uuid.uuid4(), "return_home")
        announce(cloud)
        await until(lambda: cloud.link.serves(DOCK))
        cloud.client.publish_error = aiomqtt.MqttError("The connection was lost.")
        with capture_logs() as more:
            unpublished = await cloud.commands.send_now(DOCK, uuid.uuid4(), "return_home")
    assert (unserved, unpublished) == (None, None)
    assert [entry["event"] for entry in logs + more] == [
        "command_not_published",
        "command_not_published",
    ]
