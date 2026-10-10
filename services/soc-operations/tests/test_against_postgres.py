from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import aiohttp
import pytest

from soc_config import Contract
from soc_database.harness import EphemeralPostgres
from soc_operations import settings
from soc_operations.service import OperationsService

pytestmark = pytest.mark.lane


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


async def test_soc_operations_comes_up_ready_as_its_role(
    migrated: EphemeralPostgres,
    passwords: dict[str, str],
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    port = unused_tcp_port_factory()
    path = tmp_path / "soc-operations.json"
    path.write_text(
        json.dumps(
            {
                **Contract.read().starting_file(settings.SERVICE),
                "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
            }
        ),
        encoding="utf-8",
    )
    loaded = settings.load(
        {
            "SOC_CONFIG_FILE": str(path),
            "SOC_HEALTH_PORT": str(port),
            "SOC_DB_HOST": "127.0.0.1",
            "SOC_DB_PORT": str(migrated.port),
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_OPERATIONS": passwords["soc_operations"],
        }
    )
    service = OperationsService(loaded, bind_host="127.0.0.1")
    task = asyncio.create_task(service.run())
    try:
        body = await ready(f"http://127.0.0.1:{port}/ready", 20)
        async with service.database.session() as connection:
            role = await connection.fetchval("select current_user")
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert body["links"]["database"]["up"] is True
    assert role == "soc_operations"
