from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import aiohttp
import pytest

from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_config import Contract
from soc_database.realtime import RealtimeStack
from soc_realtime import Endpoint
from soc_realtime.socket import Connector

pytestmark = pytest.mark.lane

STACK = {
    "name": "lab",
    "broker": {
        "host": "so-mosquitto",
        "port": 1883,
        "username": "cloud-client",
        "password_env": "SOC_MQTT_PASSWORD_LAB",
        "client_id": "cloud-client",
    },
    "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_LAB"},
    "flight_files_url": "http://soc-cloud:8090",
}


def environment(
    platform: RealtimeStack, passwords: dict[str, str], directory: Path, ports: list[int]
) -> dict[str, str]:
    values: dict[str, Any] = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
        "stacks": [STACK],
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
        "SOC_MQTT_PASSWORD_LAB": "m" * 40,
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


async def test_soc_cloud_comes_up_ready_on_the_platform(
    platform: RealtimeStack,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = [unused_tcp_port_factory(), unused_tcp_port_factory()]
    loaded = settings.load(environment(platform, passwords, tmp_path, ports))
    loaded = replace(loaded, realtime=Endpoint(platform.base, loaded.realtime.key))
    service = CloudService(loaded, realtime_connector=connector, health_host="127.0.0.1")
    task = asyncio.create_task(service.run())
    try:
        body = await ready(f"http://127.0.0.1:{ports[0]}/ready", 30)
        assert service.realtime.joined("org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:telemetry")
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert body["service"] == "soc-cloud"
    assert {name: link["up"] for name, link in body["links"].items()} == {
        "database": True,
        "realtime": True,
    }
