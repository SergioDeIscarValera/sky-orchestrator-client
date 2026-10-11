from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, cast

import aiomqtt
import pytest

import soc_config
from soc_cloud.link.stack import StackLink
from soc_cloud.presence import PostgresPresenceStore, PresenceRecorder
from soc_cloud.settings import Api, Broker, Stack, StackCredentials
from soc_cloud.testing import FakeClient
from soc_cloud.wire import MQTT, WireContract
from soc_database.harness import Tenancy
from soc_database.realtime import RealtimeStack
from soc_db import Database, Target

pytestmark = pytest.mark.lane

DOCK = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV001"
OFFLINE_WITHIN_S = 1.0


def example(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((MQTT / "examples" / f"{name}.json").read_text())
    return loaded


def stack(organization: uuid.UUID) -> Stack:
    return Stack(
        name="lab",
        organization=organization,
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


class Recording:
    def __init__(self, platform: RealtimeStack, passwords: dict[str, str]) -> None:
        self.database = Database(
            Target(
                host="127.0.0.1",
                port=platform.postgres.port,
                database="postgres",
                role="soc_cloud",
                password=passwords["soc_cloud"],
                application_name="soc-cloud-test",
            )
        )
        self.recorder = PresenceRecorder(PostgresPresenceStore(self.database), retry_s=0.01)
        self.client = FakeClient()

    def link(self, organization: uuid.UUID) -> StackLink:
        credentials = StackCredentials(
            broker_password=soc_config.Secret("b" * 40), api_token=soc_config.Secret("t" * 40)
        )
        return StackLink(
            stack(organization),
            credentials,
            WireContract(),
            on_sample=lambda _sample: None,
            presence=self.recorder.for_stack("lab", organization),
        )

    async def receive(self, link: StackLink, topic: str, message: dict[str, Any]) -> None:
        payload = json.dumps(message).encode()
        await link.receive(cast(aiomqtt.Client, self.client), topic, payload)


@asynccontextmanager
async def recording(platform: RealtimeStack, passwords: dict[str, str]) -> AsyncIterator[Recording]:
    record = Recording(platform, passwords)
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(record.database.run()), group.create_task(record.recorder.run())]
        try:
            yield record
        finally:
            for task in tasks:
                task.cancel()


async def online_in_the_database(admin: Any) -> bool | None:
    online: bool | None = await admin.fetchval(
        "select online from soc.devices where gateway_sn = $1 and aircraft_sn = $2", DOCK, AIRCRAFT
    )
    return online


async def until(condition: Any, within_s: float = 5.0) -> float:
    started = time.monotonic()
    async with asyncio.timeout(within_s):
        while not await condition():
            await asyncio.sleep(0.005)
    return time.monotonic() - started


async def test_an_aircraft_dropped_from_the_topology_is_offline_within_a_second(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        organization = (await Tenancy(admin).member()).organization_id
        await admin.execute("delete from soc.stacks where gateway_sn = $1", DOCK)
        async with recording(platform, passwords) as record:
            link = record.link(organization)
            dock_osd = example("osd.dock")
            dock_osd["data"]["sub_device"]["device_online_status"] = 1
            await record.receive(link, f"sys/product/{DOCK}/status", example("sys.update_topo"))
            await record.receive(link, f"thing/product/{DOCK}/osd", dock_osd)

            async def online() -> bool:
                return await online_in_the_database(admin) is True

            await until(online)
            stack_row = await admin.fetchrow(
                "select name, organization_id from soc.stacks where gateway_sn = $1", DOCK
            )
            assert stack_row is not None
            assert (stack_row["name"], stack_row["organization_id"]) == ("lab", organization)

            empty = example("sys.update_topo")
            empty["data"]["sub_devices"] = []
            await record.receive(link, f"sys/product/{DOCK}/status", empty)

            async def offline() -> bool:
                return await online_in_the_database(admin) is False

            took_s = await until(offline)
        assert took_s < OFFLINE_WITHIN_S, f"{took_s:.3f} s"
    finally:
        await admin.close()


async def test_an_aircrafts_firmware_reaches_its_device(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        organization = (await Tenancy(admin).member()).organization_id
        await admin.execute("delete from soc.stacks where gateway_sn = $1", DOCK)
        async with recording(platform, passwords) as record:
            link = record.link(organization)
            await record.receive(link, f"sys/product/{DOCK}/status", example("sys.update_topo"))
            await record.receive(link, f"thing/product/{AIRCRAFT}/state", example("state.aircraft"))

            async def recorded() -> bool:
                version = await admin.fetchval(
                    "select firmware_version from soc.devices where aircraft_sn = $1", AIRCRAFT
                )
                return bool(version == example("state.aircraft")["data"]["firmware_version"])

            await until(recorded)
    finally:
        await admin.close()
