"""Dry runs judged end to end, with SOC's migrations and a wayline API on loopback (FR-LNK-09).

soc-operations inserts a dry run as its own role; soc-cloud, running as a whole service, hears
the announcement (or the sweep finds it when it starts) and judges it on the wayline API the
configuration names; the verdict lands in the row. The API receives the file's bytes and the
takeoff in the order SO takes it, latitude first.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import aiohttp
import asyncpg
import pytest

from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_cloud.testing import WAYLINE_VALIDATION, EphemeralMosquitto, WaylineServer, wayline_server
from soc_config import Contract
from soc_database.harness import Flown, Operations, Tenancy
from soc_database.realtime import RealtimeStack
from soc_realtime import Endpoint
from soc_realtime.socket import Connector

pytestmark = pytest.mark.lane

TOKEN = "t" * 40
FILE = b"PK\x03\x04kmz"
INSERT_DRY_RUN = (
    "insert into soc.dry_runs (organization_id, file_id, gateway_sn)"
    " values ($1, $2, $3) returning id"
)
VERDICT = "select status::text as status, verdict from soc.dry_runs where id = $1"
# The takeoff the harness gives its wayline: [longitude, latitude] in the database, which SO
# takes as latitude then longitude.
FARM_LATITUDE, FARM_LONGITUDE = "41.6523", "-4.7245"


@dataclass(frozen=True)
class Farm:
    """An operation flown on a stack named lab, the two roles that judge and ask for it, and
    the wayline API the stack answers on."""

    admin: asyncpg.Connection
    operations: asyncpg.Connection
    flown: Flown
    wayline: WaylineServer


def without_nulls(value: Any) -> Any:
    """The stored verdict without the nulls for the fields SO left out (each None in the
    contract, whether SO sent null or nothing)."""
    if isinstance(value, dict):
        return {key: without_nulls(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [without_nulls(item) for item in value]
    return value


@asynccontextmanager
async def farm(platform: RealtimeStack, passwords: dict[str, str]) -> AsyncIterator[Farm]:
    admin = await platform.postgres.connect("supabase_admin")
    operations = await platform.postgres.connect("soc_operations", passwords["soc_operations"])
    try:
        member = await Tenancy(admin).member()
        flown = await Operations(admin).flown(member.organization_id, file=FILE)
        async with wayline_server() as wayline:
            yield Farm(admin, operations, flown, wayline)
    finally:
        await operations.close()
        await admin.close()


def environment(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    directory: Path,
    ports: list[int],
    farm_of: Farm,
) -> dict[str, str]:
    stack = {
        "name": "lab",
        "organization": str(farm_of.flown.organization_id),
        "broker": {
            "host": "127.0.0.1",
            "port": broker.port,
            "username": "cloud-client",
            "password_env": "SOC_MQTT_PASSWORD_LAB",
            "client_id": "cloud-client",
        },
        "api": {"url": farm_of.wayline.base_url, "token_env": "SOC_SO_API_TOKEN_LAB"},
        "flight_files_url": f"http://127.0.0.1:{ports[1]}",
    }
    values: dict[str, Any] = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": [str(farm_of.flown.organization_id)],
        "stacks": [stack],
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
        "SOC_SO_API_TOKEN_LAB": TOKEN,
    }


async def ready(url: str, within_s: float) -> None:
    async with aiohttp.ClientSession() as session, asyncio.timeout(within_s):
        while True:
            try:
                async with session.get(url) as response:
                    if response.status == 200:
                        return
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
    farm_of: Farm,
) -> AsyncIterator[CloudService]:
    loaded = settings.load(environment(platform, broker, passwords, directory, ports, farm_of))
    loaded = replace(loaded, realtime=Endpoint(platform.base, loaded.realtime.key))
    service = CloudService(loaded, realtime_connector=connector, bind_host="127.0.0.1")
    task = asyncio.create_task(service.run())
    try:
        await ready(f"http://127.0.0.1:{ports[0]}/ready", 30)
        yield service
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def request_dry_run(farm_of: Farm, gateway: str | None = None) -> uuid.UUID:
    run: uuid.UUID = await farm_of.operations.fetchval(
        INSERT_DRY_RUN,
        farm_of.flown.organization_id,
        farm_of.flown.file_id,
        gateway or farm_of.flown.gateway_sn,
    )
    return run


async def judged(admin: asyncpg.Connection, run: uuid.UUID) -> asyncpg.Record:
    """The row once its run is no longer pending."""
    async with asyncio.timeout(30):
        while True:
            row = await admin.fetchrow(VERDICT, run)
            assert row is not None
            if row["status"] != "pending":
                return row
            await asyncio.sleep(0.05)


def ports_from(unused_tcp_port_factory: Callable[[], int]) -> list[int]:
    return [unused_tcp_port_factory(), unused_tcp_port_factory()]


async def test_a_dry_run_announced_while_soc_cloud_runs_is_judged_end_to_end(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = ports_from(unused_tcp_port_factory)
    async with (
        farm(platform, passwords) as judging,
        running_service(platform, broker, passwords, connector, tmp_path, ports, judging),
    ):
        run = await request_dry_run(judging)
        row = await judged(judging.admin, run)
    assert row["status"] == "rejected"
    assert without_nulls(json.loads(row["verdict"])) == WAYLINE_VALIDATION
    (judgement,) = judging.wayline.judgements
    assert judgement.query == {
        "takeoff_latitude_deg": FARM_LATITUDE,
        "takeoff_longitude_deg": FARM_LONGITUDE,
    }
    assert judgement.body == FILE
    assert judgement.authorization == f"Bearer {TOKEN}"


async def test_a_dry_run_requested_while_soc_cloud_was_away_is_judged_when_it_starts(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = ports_from(unused_tcp_port_factory)
    async with farm(platform, passwords) as judging:
        run = await request_dry_run(judging)
        async with running_service(
            platform, broker, passwords, connector, tmp_path, ports, judging
        ):
            row = await judged(judging.admin, run)
    assert row["status"] == "rejected"
    assert len(judging.wayline.judgements) == 1


async def test_a_dry_run_for_a_stack_soc_cloud_does_not_serve_fails_with_that_reason(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = ports_from(unused_tcp_port_factory)
    async with farm(platform, passwords) as judging:
        elsewhere = f"SOTEST{uuid.uuid4().hex[:8].upper()}"
        await judging.admin.execute(
            "select soc.record_stack($1, 'elsewhere', $2, 'connected')",
            elsewhere,
            judging.flown.organization_id,
        )
        async with running_service(
            platform, broker, passwords, connector, tmp_path, ports, judging
        ):
            run = await request_dry_run(judging, gateway=elsewhere)
            row = await judged(judging.admin, run)
    assert row["status"] == "failed"
    assert json.loads(row["verdict"]) == {
        "error": "stack elsewhere is not served by this soc-cloud"
    }
    assert judging.wayline.judgements == []


async def test_a_judgement_the_stack_refuses_fails_the_run_with_what_it_said(
    platform: RealtimeStack,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    connector: Connector,
    tmp_path: Path,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    ports = ports_from(unused_tcp_port_factory)
    async with farm(platform, passwords) as judging:
        judging.wayline.validation_code = 500
        async with running_service(
            platform, broker, passwords, connector, tmp_path, ports, judging
        ):
            run = await request_dry_run(judging)
            row = await judged(judging.admin, run)
    assert row["status"] == "failed"
    error = json.loads(row["verdict"])["error"]
    assert "500" in error
    assert "the judgement is refused" in error
