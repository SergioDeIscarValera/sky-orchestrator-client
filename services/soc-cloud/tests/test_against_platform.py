from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import statistics
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import aiohttp
import aiomqtt
import asyncpg
import pytest

from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_cloud.testing import CLOUD_CLIENT, EphemeralMosquitto
from soc_cloud.wire import MQTT
from soc_config import Contract
from soc_database.harness import Operations, Tenancy
from soc_database.realtime import RealtimeStack
from soc_realtime import Endpoint
from soc_realtime.socket import Connector
from soc_realtime.testing import Subscriber

pytestmark = pytest.mark.lane

DOCK = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV001"
FARM = uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a")
SAMPLES = 50


def stack_on(broker: EphemeralMosquitto, files_port: int) -> dict[str, Any]:
    return {
        "name": "lab",
        "organization": "6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a",
        "broker": {
            "host": "127.0.0.1",
            "port": broker.port,
            "username": CLOUD_CLIENT,
            "password_env": "SOC_MQTT_PASSWORD_LAB",
            "client_id": CLOUD_CLIENT,
        },
        "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_LAB"},
        "flight_files_url": f"http://127.0.0.1:{files_port}",
    }


def environment(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    directory: Path,
    ports: list[int],
    tunables: dict[str, Any] | None = None,
) -> dict[str, str]:
    values: dict[str, Any] = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
        "stacks": [stack_on(broker, ports[1])],
        **(tunables or {}),
    }
    path = directory / "soc-cloud.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return {
        "SOC_CONFIG_FILE": str(path),
        "SOC_HEALTH_PORT": str(ports[0]),
        "SOC_FLIGHT_FILES_PORT": str(ports[1]),
        "SOC_DB_HOST": "127.0.0.1",
        "SOC_DB_PORT": str(platform.postgres.port),
        "SOC_DB_NAME": "postgres",
        "SOC_DB_PASSWORD_SOC_CLOUD": passwords["soc_cloud"],
        "SOC_SUPABASE_URL": f"http://{platform.host}:{platform.port}",
        "SOC_SUPABASE_SERVICE_ROLE_KEY": platform.service_key(),
        "SOC_MQTT_PASSWORD_LAB": broker.cloud_password,
        "SOC_SO_API_TOKEN_LAB": "t" * 40,
    }


async def ready(url: str, within_s: float) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session, asyncio.timeout(within_s):
        while True:
            try:
                async with session.get(url) as response:
                    if response.status == 200:
                        body: dict[str, Any] = await response.json()
                        return body
            except aiohttp.ClientConnectionError:
                pass
            await asyncio.sleep(0.1)


@asynccontextmanager
async def running_service(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    directory: Path,
    ports: list[int],
    tunables: dict[str, Any] | None = None,
) -> AsyncIterator[tuple[CloudService, dict[str, Any]]]:
    loaded = settings.load(environment(platform, broker, passwords, directory, ports, tunables))
    loaded = replace(loaded, realtime=Endpoint(platform.base, loaded.realtime.key))
    service = CloudService(loaded, realtime_connector=connector, bind_host="127.0.0.1")
    task = asyncio.create_task(service.run())
    try:
        yield service, await ready(f"http://127.0.0.1:{ports[0]}/ready", 30)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_soc_cloud_comes_up_ready_on_the_platform_and_its_stack(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    async with running_service(platform, broker, passwords, connector, tmp_path, ports) as (
        service,
        body,
    ):
        assert service.realtime.joined("org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:telemetry")
    assert body["service"] == "soc-cloud"
    assert {name: link["up"] for name, link in body["links"].items()} == {
        "database": True,
        "realtime": True,
        "flight_files": True,
        "stack:lab": True,
    }


async def test_the_dock_asks_for_a_flight_file_and_downloads_its_exact_bytes(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    kmz = b"PK\x03\x04" + bytes(range(256)) * 16
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    async with running_service(platform, broker, passwords, connector, tmp_path, ports) as (
        service,
        _,
    ):
        service.files.keep("flight-1", kmz)
        request = json.loads(
            (MQTT / "examples" / "requests.flighttask_resource_get.json").read_text()
        )
        request = {**request, "tid": str(uuid.uuid4()), "data": {"flight_id": "flight-1"}}
        dock_sn = request["gateway"]
        async with broker.dock() as dock:
            await dock.subscribe(f"thing/product/{dock_sn}/requests_reply", qos=1)
            await dock.publish(f"thing/product/{dock_sn}/requests", json.dumps(request), qos=1)
            async with asyncio.timeout(5):
                async for message in dock.messages:
                    assert isinstance(message.payload, bytes)
                    reply = json.loads(message.payload)
                    if reply["tid"] == request["tid"]:
                        break
        offered = reply["data"]["output"]["file"]
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session,
            session.get(offered["url"], allow_redirects=False) as response,
        ):
            downloaded = await response.read()
    assert reply["data"]["result"] == 0
    assert hashlib.md5(downloaded, usedforsecurity=False).hexdigest() == offered["fingerprint"]
    assert downloaded == kmz


# Each intent names its organization's flight, which the requester seeds.
INSERT_INTENT = """
insert into soc.command_intents
  (client_request_id, organization_id, operation_id, flight_id, gateway_sn, verb, requested_at)
select gen_random_uuid(), $1, f.operation_id, f.id, $2, 'return_home',
       now() - make_interval(secs => $3)
  from soc.flights f where f.organization_id = $1 limit 1
returning id
"""


class Dock:
    """so-gateway's side: announces itself, and answers every service with result 0."""

    def __init__(self, client: aiomqtt.Client, serial: str) -> None:
        self.client = client
        self.serial = serial
        self.received: list[str] = []

    async def serve(self) -> None:
        await self.client.subscribe(f"thing/product/{self.serial}/services", qos=1)
        announcer = asyncio.create_task(self._announce())
        try:
            async for message in self.client.messages:
                assert isinstance(message.payload, bytes)
                service = json.loads(message.payload)
                self.received.append(service["tid"])
                reply = {
                    "tid": service["tid"],
                    "bid": service["bid"],
                    "timestamp": service["timestamp"],
                    "method": service["method"],
                    "data": {"result": 0},
                }
                await self.client.publish(
                    f"thing/product/{self.serial}/services_reply", json.dumps(reply), qos=1
                )
        finally:
            announcer.cancel()

    async def _announce(self) -> None:
        announcement = json.loads((MQTT / "examples" / "sys.update_topo.json").read_text())
        while True:
            message = {**announcement, "tid": str(uuid.uuid4())}
            await self.client.publish(
                f"sys/product/{self.serial}/status", json.dumps(message), qos=1
            )
            await asyncio.sleep(0.5)


@asynccontextmanager
async def dock_answering(broker: EphemeralMosquitto, serial: str) -> AsyncIterator[Dock]:
    async with broker.dock() as client:
        dock = Dock(client, serial)
        task = asyncio.create_task(dock.serve())
        try:
            yield dock
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


@asynccontextmanager
async def requester(
    platform: RealtimeStack, passwords: dict[str, str]
) -> AsyncIterator[tuple[asyncpg.Connection, uuid.UUID]]:
    admin = await platform.postgres.connect("supabase_admin")
    operations = await platform.postgres.connect("soc_operations", passwords["soc_operations"])
    try:
        member = await Tenancy(admin).member()
        await Operations(admin).flown(member.organization_id)
        yield operations, member.organization_id
    finally:
        await operations.close()
        await admin.close()


async def statuses(connection: asyncpg.Connection, intents: list[uuid.UUID]) -> dict[str, int]:
    rows = await connection.fetch(
        "select status::text, count(*) from soc.command_intents where id = any($1) group by 1",
        intents,
    )
    return {row["status"]: row["count"] for row in rows}


async def test_commands_reach_the_wire_through_pg_notify_within_50_ms_at_p95(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    async with (
        requester(platform, passwords) as (operations, organization),
        running_service(platform, broker, passwords, connector, tmp_path, ports) as (service, _),
        dock_answering(broker, DOCK) as dock,
    ):
        await until(lambda: service.links[0].serves(DOCK), 10)
        intents = []
        for _ in range(100):
            intent = await operations.fetchval(INSERT_INTENT, organization, DOCK, 0)
            intents.append(intent)
            await until_accepted(operations, [intent])
        p95_ms = await operations.fetchval(
            "select percentile_cont(0.95) within group"
            " (order by extract(epoch from sent_at - requested_at) * 1000)"
            " from soc.command_intents where id = any($1)",
            intents,
        )
    assert sorted(dock.received) == sorted(str(intent) for intent in intents)
    assert p95_ms < 50, f"p95 from commit to claim was {p95_ms:.1f} ms"


async def test_a_command_committed_while_soc_cloud_was_away_runs_once_or_expires(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    async with requester(platform, passwords) as (operations, organization):
        fresh = await operations.fetchval(INSERT_INTENT, organization, DOCK, 0)
        stale = await operations.fetchval(INSERT_INTENT, organization, DOCK, 11)
        async with (
            running_service(platform, broker, passwords, connector, tmp_path, ports),
            dock_answering(broker, DOCK) as dock,
        ):
            await until_accepted(operations, [fresh])
            await asyncio.sleep(0.5)
        assert await statuses(operations, [fresh, stale]) == {"accepted": 1, "expired": 1}
    assert dock.received == [str(fresh)]


async def until_accepted(connection: asyncpg.Connection, intents: list[uuid.UUID]) -> None:
    async with asyncio.timeout(30):
        while (await statuses(connection, intents)).get("accepted", 0) < len(intents):
            await asyncio.sleep(0.005)


async def until(condition: Callable[[], bool], within_s: float) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.05)


async def farm_member_and_stranger(platform: RealtimeStack) -> tuple[uuid.UUID, uuid.UUID]:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        tenancy = Tenancy(admin)
        member = await tenancy.user()
        await admin.execute(
            "insert into public.organizations (id, name, owner_id) values ($1, 'Farm', $2)"
            " on conflict (id) do nothing",
            FARM,
            member,
        )
        await tenancy.join(member, FARM, "viewer")
        stranger = (await tenancy.member("owner")).user_id
    finally:
        await admin.close()
    return member, stranger


async def test_every_sample_reaches_the_farms_members_in_order_and_no_one_else(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    member, stranger = await farm_member_and_stranger(platform)
    topic = f"org:{FARM}:soc:telemetry"
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    published: dict[int, float] = {}
    received: list[tuple[int, float]] = []
    async with (
        running_service(platform, broker, passwords, connector, tmp_path, ports),
        Subscriber(platform.base, platform.member_token(member), topic, connector) as browser,
        Subscriber(platform.base, platform.member_token(stranger), topic, connector) as outsider,
        broker.dock(identifier="telemetry-dock") as dock,
    ):
        assert browser.joined and not outsider.joined

        async def receive() -> None:
            while len(received) < SAMPLES:
                frame = await browser.broadcast(within_s=10)
                received.append((frame["payload"]["taken_at_ms"], time.monotonic()))

        reader = asyncio.create_task(receive())
        osd = json.loads((MQTT / "examples" / "osd.aircraft.json").read_text())
        for index in range(SAMPLES):
            osd["timestamp"] = 1_790_800_000_000 + index * 200
            published[osd["timestamp"]] = time.monotonic()
            await dock.publish(f"thing/product/{AIRCRAFT}/osd", json.dumps(osd), qos=1)
            await asyncio.sleep(0.2)
        await asyncio.wait_for(reader, 10)
    assert [taken for taken, _ in received] == sorted(published)
    latencies_ms = sorted((at - published[taken]) * 1000 for taken, at in received)
    p95_ms = statistics.quantiles(latencies_ms, n=20)[-1]
    print(f"telemetry p95 {p95_ms:.1f} ms, max {latencies_ms[-1]:.1f} ms")
    assert p95_ms <= 150, f"p95 from the dock to a member was {p95_ms:.1f} ms"


# --- A flight: its geofence, its moments, its track (FR-SAF-01, FR-LOG-02, FR-TEL-04) ----

INSIDE = (41.6523, -4.7245)
OUTSIDE = (41.6523, -4.7262)


def osd(gateway: str, at_ms: int, where: tuple[float, float], mode: int) -> str:
    message = json.loads((MQTT / "examples" / "osd.aircraft.json").read_text())
    message.update(tid=str(uuid.uuid4()), timestamp=at_ms, gateway=gateway)
    message["data"].update(latitude=where[0], longitude=where[1], elevation=30.0, mode_code=mode)
    return json.dumps(message)


def flight_progress(gateway: str, flight: uuid.UUID, status: str, result: int = 0) -> str:
    message = json.loads((MQTT / "examples" / "events.flighttask_progress.json").read_text())
    message.update(tid=str(uuid.uuid4()), bid=str(flight), gateway=gateway)
    message["data"]["result"] = result
    message["data"]["output"]["status"] = status
    message["data"]["output"]["ext"]["flight_id"] = str(flight)
    return json.dumps(message)


class Returns:
    """The dock's services topic: when each return home arrived; each is answered 0."""

    def __init__(self, client: aiomqtt.Client, serial: str) -> None:
        self.client = client
        self.serial = serial
        self.arrived: list[tuple[str, float]] = []

    async def serve(self) -> None:
        await self.client.subscribe(f"thing/product/{self.serial}/services", qos=1)
        announcer = asyncio.create_task(Dock(self.client, self.serial)._announce())
        try:
            await self._answer()
        finally:
            announcer.cancel()

    async def _answer(self) -> None:
        async for message in self.client.messages:
            assert isinstance(message.payload, bytes)
            service = json.loads(message.payload)
            self.arrived.append((service["method"], time.monotonic()))
            reply = {**{key: service[key] for key in ("tid", "bid", "timestamp", "method")}}
            reply["data"] = {"result": 0}
            await self.client.publish(
                f"thing/product/{self.serial}/services_reply", json.dumps(reply), qos=1
            )


async def test_a_breach_returns_the_aircraft_within_100_ms_once_across_a_restart(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        flown = await Operations(admin).flown((await Tenancy(admin).member()).organization_id)
        gateway, aircraft, flight = flown.gateway_sn, flown.aircraft_sn, flown.flight_id
        topic, events = f"thing/product/{aircraft}/osd", f"thing/product/{gateway}/events"
        ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
        tunables = {"telemetry_batch_s": 1}
        at = 1_791_000_000_000
        async with broker.dock(identifier="flight-dock") as client:
            returns = Returns(client, gateway)
            answering = asyncio.create_task(returns.serve())
            async with running_service(
                platform, broker, passwords, connector, tmp_path, ports, tunables
            ) as (service, _):
                await until(lambda: service.links[0].serves(gateway), 10)
                await until(lambda: service.flights.watched(flight) is not None, 10)
                await client.publish(events, flight_progress(gateway, flight, "in_progress"), qos=1)
                await until(
                    lambda: getattr(service.flights.watched(flight), "executing", False), 10
                )
                for step, mode in enumerate([0, 4, 5, 5, 5]):
                    await client.publish(topic, osd(gateway, at + step * 400, INSIDE, mode), qos=1)
                    await asyncio.sleep(0.05)
                sent = time.monotonic()
                await client.publish(topic, osd(gateway, at + 2400, OUTSIDE, 5), qos=1)
                for step in range(1, 4):
                    await client.publish(
                        topic, osd(gateway, at + 2400 + step * 200, OUTSIDE, 9), qos=1
                    )
                await until(lambda: len(returns.arrived) == 1, 5)
                await asyncio.sleep(1.5)
            # A restart reads the breach back: samples outside send nothing more.
            async with running_service(
                platform, broker, passwords, connector, tmp_path, ports, tunables
            ) as (service, _):
                await until(lambda: getattr(service.flights.watched(flight), "breached", False), 10)
                for step in range(3):
                    await client.publish(
                        topic, osd(gateway, at + 4000 + step * 200, OUTSIDE, 9), qos=1
                    )
                await asyncio.sleep(0.5)
                await client.publish(
                    events, flight_progress(gateway, flight, "failed", 322283), qos=1
                )
                await asyncio.sleep(0.3)
                await client.publish(topic, osd(gateway, at + 6000, INSIDE, 0), qos=1)
                await asyncio.sleep(1.5)
            answering.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await answering
        (method, arrived), *more = returns.arrived
        assert (method, more) == ("return_home", [])
        reaction_ms = (arrived - sent) * 1000
        print(f"geofence return {reaction_ms:.1f} ms after the sample left the dock")
        assert reaction_ms < 100, f"the return reached the dock {reaction_ms:.1f} ms after"

        row = await admin.fetchrow(
            "select took_off_at, landed_at, breached_at from soc.flights where id = $1", flight
        )
        assert row is not None
        assert None not in (row["took_off_at"], row["landed_at"], row["breached_at"])
        state = await admin.fetchrow(
            "select status::text as status, end_reason::text as reason"
            " from soc.flight_states where flight_id = $1",
            flight,
        )
        assert state is not None
        assert (state["status"], state["reason"]) == ("failed", "geofence_breach")
        intent = await admin.fetchrow(
            "select status::text as status, result from soc.command_intents"
            " where flight_id = $1 and verb = 'return_home'",
            flight,
        )
        assert intent is not None and (intent["status"], intent["result"]) == ("accepted", 0)
        events_logged = await admin.fetch(
            "select kind, severity::text as severity, source::text as source"
            " from soc.operation_events where flight_id = $1 order by recorded_at",
            flight,
        )
        kinds = [event["kind"] for event in events_logged]
        assert sorted(kinds) == sorted(
            [
                "flight_status_changed",
                "took_off",
                "command_requested",
                "geofence_breach",
                "command_outcome",
                "automatic_return",
                "flight_status_changed",
                "landed",
            ]
        ), kinds
        # The aircraft's own return may be heard while the breach is being recorded.
        assert kinds[:2] == ["flight_status_changed", "took_off"], kinds
        assert kinds[-2:] == ["flight_status_changed", "landed"], kinds
        breach = [kind for kind in kinds if kind.startswith(("command", "geofence"))]
        assert breach == ["command_requested", "geofence_breach", "command_outcome"], kinds
        sources = {event["kind"]: (event["severity"], event["source"]) for event in events_logged}
        assert sources["geofence_breach"] == ("safety", "soc-cloud")
        assert sources["command_requested"] == ("info", "soc-cloud")
        track = await admin.fetchval(
            "select count(*) from soc.telemetry_samples where flight_id = $1", flight
        )
        assert track >= 5
        latest = await admin.fetchval(
            "select sample from soc.aircraft_samples where aircraft_sn = $1", aircraft
        )
        assert json.loads(latest)["latitude_deg"] == INSIDE[0]
    finally:
        await admin.close()
