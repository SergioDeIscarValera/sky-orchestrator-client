from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import aiohttp
import pytest

from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_cloud.testing import CLOUD_CLIENT, EphemeralMosquitto
from soc_cloud.wire import MQTT
from soc_config import Contract
from soc_database.realtime import RealtimeStack
from soc_realtime import Endpoint
from soc_realtime.socket import Connector

pytestmark = pytest.mark.lane


def stack_on(broker: EphemeralMosquitto, files_port: int) -> dict[str, Any]:
    return {
        "name": "lab",
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
) -> dict[str, str]:
    values: dict[str, Any] = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
        "stacks": [stack_on(broker, ports[1])],
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
) -> AsyncIterator[tuple[CloudService, dict[str, Any]]]:
    loaded = settings.load(environment(platform, broker, passwords, directory, ports))
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
