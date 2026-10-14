"""An operation against Sky Orchestrator's released stack, as SOC's end to end flies it (M4).

SOC's two services run in this process on Virtual Origen's platform: soc-cloud on the stack's
broker and API, its flight files on the stack network's gateway, and soc-operations on the
database. The organization's fleet, geofence, wayline and operation are seeded for the stack's
aircraft. The tests that fly it ask each move, through the database's RPCs or in the console,
and read what the database and the stack hold; this module is what they share.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import statistics
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any

import aiohttp
import asyncpg

from soc_cloud import settings as cloud_settings
from soc_cloud.service import CloudService
from soc_config import Contract
from soc_database.harness import impersonate
from soc_e2e.platform import Platform
from soc_e2e.so_stack import Site, SoStack, free_port
from soc_operations import settings as operations_settings
from soc_operations.judging import judged
from soc_operations.runner import Runner
from soc_operations.testing import FLIGHT, ROUTE, SQUARE

#: Finca Norte: the route's takeoff, where the fake bridge's aircraft stands at the start. Its
#: envelope allows 100 m, above the geofence's 60 m ceiling: the phone returns home at the
#: prepare's rth_altitude (SO's DEP-29), not at its envelope's max_height_m.
FARM = Site(latitude_deg=41.6523, longitude_deg=-4.7245)
STACK = "lab"
#: DJI's mode code while the aircraft flies a wayline.
WAYLINE_MODE = 5
#: The route's highest waypoint, and the operation's takeoff security height, which the prepare
#: asks as its return height (soc-operations' lifecycle, at least DJI's 20 m; seed's 20 m).
HIGHEST_WAYPOINT_M = max(float(waypoint["height_m"]) for waypoint in FLIGHT["waypoints"])
RETURN_HEIGHT_M = 20


async def until(probe: Callable[[], Awaitable[Any]], within_s: float, what: str) -> Any:
    try:
        async with asyncio.timeout(within_s):
            while True:
                value = await probe()
                if value:
                    return value
                await asyncio.sleep(0.1)
    except TimeoutError:
        raise AssertionError(f"not within {within_s:g} s: {what}") from None


# --- SOC's two services, in this process ---------------------------------------------------


@asynccontextmanager
async def running_cloud(
    platform: Platform,
    passwords: dict[str, str],
    so: SoStack,
    organization: uuid.UUID,
    directory: Path,
) -> AsyncIterator[CloudService]:
    """soc-cloud on the stack's broker and API, its files served on the stack's network."""
    health, files = free_port(), free_port()
    values: dict[str, Any] = {
        **Contract.read().starting_file(cloud_settings.SERVICE),
        "served_organizations": [str(organization)],
        "stacks": [
            {
                "name": STACK,
                "organization": str(organization),
                "broker": {
                    "host": "127.0.0.1",
                    "port": so.mqtt_port,
                    "username": "cloud-client",
                    "password_env": "SOC_MQTT_PASSWORD_LAB",
                    "client_id": "cloud-client",
                },
                "api": {"url": so.api_url, "token_env": "SOC_SO_API_TOKEN_LAB"},
                "flight_files_url": f"http://{so.gateway}:{files}",
            }
        ],
    }
    path = directory / "soc-cloud.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    loaded = cloud_settings.load(
        {
            "SOC_CONFIG_FILE": str(path),
            "SOC_HEALTH_PORT": str(health),
            "SOC_FLIGHT_FILES_PORT": str(files),
            "SOC_DB_HOST": "127.0.0.1",
            "SOC_DB_PORT": str(platform.stack.postgres.port),
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_CLOUD": passwords["soc_cloud"],
            "SOC_SUPABASE_URL": platform.url,
            "SOC_SUPABASE_SERVICE_ROLE_KEY": platform.service_key(),
            "SOC_MQTT_PASSWORD_LAB": so.cloud_password,
            "SOC_SO_API_TOKEN_LAB": so.api_token,
        }
    )
    # The flight files and health on the stack network's gateway: so-wayline fetches there.
    service = CloudService(loaded, bind_host=so.gateway)
    task = asyncio.create_task(service.run())
    try:
        async with aiohttp.ClientSession() as session, asyncio.timeout(60):
            while True:
                with contextlib.suppress(aiohttp.ClientConnectionError):
                    async with session.get(f"http://{so.gateway}:{health}/ready") as response:
                        if response.status == 200:
                            break
                await asyncio.sleep(0.2)
        yield service
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, TimeoutError):
            await asyncio.wait_for(task, 10)


@asynccontextmanager
async def running_operations(
    platform: Platform, passwords: dict[str, str], organization: uuid.UUID, directory: Path
) -> AsyncIterator[Runner]:
    path = directory / "soc-operations.json"
    path.write_text(
        json.dumps(
            {
                **Contract.read().starting_file(operations_settings.SERVICE),
                "served_organizations": [str(organization)],
            }
        ),
        encoding="utf-8",
    )
    loaded = operations_settings.load(
        {
            "SOC_CONFIG_FILE": str(path),
            "SOC_HEALTH_PORT": str(free_port()),
            "SOC_DB_HOST": "127.0.0.1",
            "SOC_DB_PORT": str(platform.stack.postgres.port),
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_OPERATIONS": passwords["soc_operations"],
        }
    )
    runner = Runner(loaded.database, loaded.tunables, judged)
    task = asyncio.create_task(runner.run())
    try:
        yield runner
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, TimeoutError):
            await asyncio.wait_for(task, 10)


# --- The organization, its fleet and its operation ------------------------------------------


async def stack_recorded(admin: asyncpg.Connection, so: SoStack) -> bool:
    """soc-cloud has heard the dock, read its status and envelope, and its aircraft is online."""
    row = await admin.fetchrow(
        "select s.status is not null and s.envelope is not null"
        " and s.flight_files_url is not null as read,"
        " exists (select 1 from soc.devices d where d.gateway_sn = s.gateway_sn"
        "   and d.aircraft_sn = $2 and d.online) as online"
        " from soc.stacks s where s.gateway_sn = $1",
        so.dock_sn, so.aircraft_sn,
    )  # fmt: skip
    return row is not None and bool(row["read"]) and bool(row["online"])


def flight_at(speed_ms: float) -> dict[str, Any]:
    """The golden flight, flown at another speed: the same waypoints, its duration their length
    over that speed. At the golden 5 m/s it is the golden flight itself."""
    flight: dict[str, Any] = copy.deepcopy(FLIGHT)
    if speed_ms != flight["speed_ms"]:
        flight["speed_ms"] = speed_ms
        flight["duration_s"] = round(flight["distance_m"] / speed_ms, 3)
    return flight


async def seed(
    admin: asyncpg.Connection,
    organization: uuid.UUID,
    pilot: uuid.UUID,
    so: SoStack,
    speed_ms: float = 5.0,
) -> uuid.UUID:
    """The stack's aircraft registered as a fleet, a geofence round the route, and a draft
    assigning them at `speed_ms`, its flight the console's for the route (FR-OPS-01)."""
    fleet = await admin.fetchval(
        "select id from soc.fleets where aircraft_sn = $1 and deleted_at is null", so.aircraft_sn
    )
    if fleet is None:
        model = await admin.fetchval("select model from soc.aircraft_models order by model limit 1")
        fleet = await admin.fetchval(
            "insert into soc.fleets (organization_id, name, model, airframe_serial, gateway_sn,"
            " aircraft_sn) values ($1, 'Norte 1', $2, '1WNBH9', $3, $4) returning id",
            organization, model, so.dock_sn, so.aircraft_sn,
        )  # fmt: skip
    geofence = await admin.fetchval(
        "insert into soc.geofences (organization_id, name, polygon, max_height_m, origin)"
        " values ($1, 'Norte', $2::jsonb, 60, 'drawn') returning id",
        organization, json.dumps(SQUARE),
    )  # fmt: skip
    wayline = await admin.fetchval(
        "insert into soc.waylines (organization_id, name, takeoff, default_height_m, design,"
        " waypoints, metrics, bake_version) values ($1, 'Route', $2::jsonb, 30, $3::jsonb,"
        " $4::jsonb, $5::jsonb, '2.2.0') returning id",
        organization, json.dumps(ROUTE["design"]["takeoff"]), json.dumps(ROUTE["design"]),
        json.dumps(ROUTE["baked"]["waypoints"]),
        json.dumps({"waypoint_count": len(ROUTE["baked"]["waypoints"]), "distance_m": 113.8}),
    )  # fmt: skip
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name, geofence_id,"
        " takeoff_security_height_m) values ($1, 'Norte', $2, 20) returning id",
        organization, geofence,
    )  # fmt: skip
    await admin.execute(
        "insert into soc.assignments (operation_id, organization_id, wayline_id, fleet_id,"
        " speed_ms, flight) values ($1, $2, $3, $4, $5, $6::jsonb)",
        operation, organization, wayline, fleet, Decimal(str(speed_ms)),
        json.dumps(flight_at(speed_ms)),
    )  # fmt: skip
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, 'pilot')",
        operation, organization, pilot,
    )  # fmt: skip
    assert isinstance(operation, uuid.UUID)
    return operation


# --- What the pilot asks, through the database --------------------------------------------


async def ask(
    admin: asyncpg.Connection, pilot: uuid.UUID, operation: uuid.UUID, transition: str
) -> uuid.UUID:
    async with admin.transaction():
        await impersonate(admin, pilot)
        request = await admin.fetchval(
            "select id from soc.request_transition($1, $2::soc.transition, $3)",
            operation, transition, uuid.uuid4(),
        )  # fmt: skip
    assert isinstance(request, uuid.UUID)
    return request


async def command(
    admin: asyncpg.Connection, pilot: uuid.UUID, flight: uuid.UUID, verb: str
) -> uuid.UUID:
    async with admin.transaction():
        await impersonate(admin, pilot)
        intent = await admin.fetchval(
            "select id from soc.request_command($1, $2::soc.command_verb, $3)",
            flight, verb, uuid.uuid4(),
        )  # fmt: skip
    assert isinstance(intent, uuid.UUID)
    return intent


async def state_of(admin: asyncpg.Connection, operation: uuid.UUID) -> str:
    return str(await admin.fetchval("select state from soc.operations where id = $1", operation))


async def reach(
    admin: asyncpg.Connection, operation: uuid.UUID, wanted: str, within_s: float
) -> None:
    async def there() -> bool:
        return await state_of(admin, operation) == wanted

    try:
        await until(there, within_s, f"the operation {wanted}")
    except AssertionError:
        print(await story(admin, operation))
        raise


async def story(admin: asyncpg.Connection, operation: uuid.UUID) -> str:
    """The operation's log and its checks, to read when a step does not come."""
    events = await admin.fetch(
        "select kind, payload from soc.operation_events where operation_id = $1"
        " order by recorded_at",
        operation,
    )
    checks = await admin.fetch(
        "select check_id, state::text as state, blocking, detail from soc.operation_checks"
        " where operation_id = $1 order by check_id",
        operation,
    )
    requests = await admin.fetch(
        "select transition::text as transition, status::text as status, reasons"
        " from soc.transition_requests where operation_id = $1 order by requested_at",
        operation,
    )
    lines = [f"{row['kind']} {row['payload']}" for row in events]
    lines += [f"{row['check_id']} {row['state']} {row['detail']}" for row in checks]
    lines += [f"request {row['transition']} {row['status']} {row['reasons']}" for row in requests]
    return "\n".join(lines)


async def blocking_checks_pass(admin: asyncpg.Connection, operation: uuid.UUID) -> bool:
    rows = await admin.fetch(
        "select state::text as state from soc.operation_checks"
        " where operation_id = $1 and blocking",
        operation,
    )
    return len(rows) > 0 and all(row["state"] == "pass" for row in rows)


async def latest_flight(admin: asyncpg.Connection, operation: uuid.UUID) -> asyncpg.Record | None:
    """The operation's latest flight with its status, or None before its first prepare."""
    row: asyncpg.Record | None = await admin.fetchrow(
        "select f.id, f.mode::text as mode, s.status::text as status from soc.flights f"
        " left join soc.flight_states s on s.flight_id = f.id"
        " where f.operation_id = $1 order by f.prepared_at desc limit 1",
        operation,
    )
    return row


async def settled(admin: asyncpg.Connection, intent: uuid.UUID) -> asyncpg.Record:
    async def answered() -> asyncpg.Record | None:
        row: asyncpg.Record | None = await admin.fetchrow(
            "select status::text as status, result,"
            " extract(epoch from sent_at - requested_at) * 1000 as wire_ms,"
            " extract(epoch from replied_at - requested_at) * 1000 as reply_ms"
            " from soc.command_intents where id = $1"
            " and status not in ('pending', 'sent')",
            intent,
        )
        return row

    row: asyncpg.Record = await until(answered, 10, f"the command {intent} answered")
    return row


def p95(values: list[float]) -> float:
    return statistics.quantiles(values, n=20)[-1]
