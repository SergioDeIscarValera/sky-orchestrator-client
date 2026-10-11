"""soc-cloud as the mini-PC runs it, in this process: one stack, `lab`, on the
ephemeral broker, serving one organization, reaching Realtime through Kong.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiohttp

from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_cloud.testing import CLOUD_CLIENT, EphemeralMosquitto
from soc_config import Contract
from soc_e2e.platform import Platform

STACK = "lab"
READY_WITHIN_S = 30
STOPPED_WITHIN_S = 10


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def environment(
    platform: Platform,
    broker: EphemeralMosquitto,
    passwords: Mapping[str, str],
    organization: uuid.UUID,
    directory: Path,
    ports: tuple[int, int],
) -> dict[str, str]:
    """soc-cloud's configuration file and environment, as compose gives them."""
    health, files = ports
    values: dict[str, Any] = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": [str(organization)],
        "stacks": [
            {
                "name": STACK,
                "organization": str(organization),
                "broker": {
                    "host": "127.0.0.1",
                    "port": broker.port,
                    "username": CLOUD_CLIENT,
                    "password_env": "SOC_MQTT_PASSWORD_LAB",
                    "client_id": CLOUD_CLIENT,
                },
                "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_LAB"},
                "flight_files_url": f"http://127.0.0.1:{files}",
            }
        ],
    }
    path = directory / "soc-cloud.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return {
        "SOC_CONFIG_FILE": str(path),
        "SOC_HEALTH_PORT": str(health),
        "SOC_FLIGHT_FILES_PORT": str(files),
        "SOC_DB_HOST": "127.0.0.1",
        "SOC_DB_PORT": str(platform.stack.postgres.port),
        "SOC_DB_NAME": "postgres",
        "SOC_DB_PASSWORD_SOC_CLOUD": passwords["soc_cloud"],
        "SOC_SUPABASE_URL": platform.url,
        "SOC_SUPABASE_SERVICE_ROLE_KEY": platform.service_key(),
        "SOC_MQTT_PASSWORD_LAB": broker.cloud_password,
        "SOC_SO_API_TOKEN_LAB": "t" * 40,
    }


async def _ready(url: str) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session, asyncio.timeout(READY_WITHIN_S):
        while True:
            with contextlib.suppress(aiohttp.ClientConnectionError):
                async with session.get(url) as response:
                    if response.status == 200:
                        body: dict[str, Any] = await response.json()
                        return body
            await asyncio.sleep(0.1)


@asynccontextmanager
async def running_cloud(
    platform: Platform,
    broker: EphemeralMosquitto,
    passwords: Mapping[str, str],
    organization: uuid.UUID,
    directory: Path,
) -> AsyncIterator[CloudService]:
    """soc-cloud, ready on every link; cancelled on the way out."""
    ports = (_free_port(), _free_port())
    loaded = settings.load(environment(platform, broker, passwords, organization, directory, ports))
    service = CloudService(loaded, bind_host="127.0.0.1")
    task = asyncio.create_task(service.run())
    try:
        await _ready(f"http://127.0.0.1:{ports[0]}/ready")
        yield service
    finally:
        task.cancel()
        # A shutdown that hangs, a socket closing through Kong say, fails the test, not the run.
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, STOPPED_WITHIN_S)
