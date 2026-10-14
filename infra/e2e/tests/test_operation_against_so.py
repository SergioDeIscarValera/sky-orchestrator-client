"""An operation flown against Sky Orchestrator's released stack and its fake bridge (M4).

SOC as it runs: soc-cloud and soc-operations in this process, on Virtual Origen's platform,
against a throwaway Sky Orchestrator stack with the fake bridge standing in for the phone. A
pilot asks every move through the database's RPCs, as the console does:

- plan, prepare, and the real checks judged on what soc-cloud reads from the stack, until
  every blocking one passes, Sky Orchestrator's dry run included;
- simulate: the flight file served to the stack, the simulated flight flown, paused and
  resumed 50 times while it flies (NFR-PERF-02's 100 commands), and ended ok;
- the stack turned to real mode: PF-MODE passes, but the fake bridge's simulator stays on,
  so PF-SIMULATOR fails and the launch is refused before anything reaches the wire. Flying
  the real launch waits for a fake bridge that can (SO's DEP-28).

Every move is in the operation's log, and each command's latency is measured: to the wire
and to its reply.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import statistics
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp
import asyncpg
import pytest

from soc_cloud import settings as cloud_settings
from soc_cloud.service import CloudService
from soc_config import Contract
from soc_database.harness import Tenancy, impersonate
from soc_e2e.platform import Platform
from soc_e2e.so_stack import Site, SoStack, free_port
from soc_operations import settings as operations_settings
from soc_operations.judging import judged
from soc_operations.runner import Runner
from soc_operations.testing import FLIGHT, ROUTE, SQUARE

pytestmark = pytest.mark.lane

#: Finca Norte: the route's takeoff, where the fake bridge's aircraft stands at the start. The
#: phone returns home at its envelope's max_height_m, not at the prepare's rth_altitude
#: (SO's HomePoint.kt, DEP-29): the envelope's height is the geofence's ceiling, 60 m, so a
#: return home stays inside it.
FARM = Site(latitude_deg=41.6523, longitude_deg=-4.7245, max_height_m=60)
STACK = "lab"
CYCLES = 50


@pytest.fixture(scope="module")
def so_stack() -> Iterator[SoStack]:
    # Twice the wall's pace: the route flies long enough to pause and resume it 50 times.
    stack = SoStack(site=FARM, pace=2)
    try:
        stack.start()
        yield stack
    except BaseException:
        print(stack.logs())
        raise
    finally:
        stack.stop()


@dataclass(frozen=True)
class Farm:
    """The organization the stack serves, and its pilot, an owner: one for the module, since a
    stack belongs to one organization."""

    organization: uuid.UUID
    pilot: uuid.UUID


@pytest.fixture(scope="module")
async def farm(platform: Platform) -> Farm:
    connection = await platform.stack.postgres.connect("supabase_admin")
    try:
        member = await Tenancy(connection).member("owner")
    finally:
        await connection.close()
    return Farm(member.organization_id, member.user_id)


@pytest.fixture
async def admin(platform: Platform) -> AsyncIterator[asyncpg.Connection]:
    connection = await platform.stack.postgres.connect("supabase_admin")
    try:
        yield connection
    finally:
        await connection.close()


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


async def seed(
    admin: asyncpg.Connection, organization: uuid.UUID, pilot: uuid.UUID, so: SoStack
) -> uuid.UUID:
    """The stack's aircraft registered as a fleet, a geofence round the route, and a draft
    assigning them, its flight the console's for the route (FR-OPS-01)."""
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
        " speed_ms, flight) values ($1, $2, $3, $4, 5, $5::jsonb)",
        operation, organization, wayline, fleet, json.dumps(FLIGHT),
    )  # fmt: skip
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, 'pilot')",
        operation, organization, pilot,
    )  # fmt: skip
    assert isinstance(operation, uuid.UUID)
    return operation


# --- What the pilot asks, as the console does ----------------------------------------------


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


async def test_an_operation_is_simulated_paused_resumed_and_held_from_a_real_launch(
    platform: Platform,
    passwords: dict[str, str],
    so_stack: SoStack,
    admin: asyncpg.Connection,
    farm: Farm,
    tmp_path: Path,
) -> None:
    organization, pilot = farm.organization, farm.pilot
    async with (
        running_cloud(platform, passwords, so_stack, organization, tmp_path),
        running_operations(platform, passwords, organization, tmp_path),
    ):
        await until(lambda: stack_recorded(admin, so_stack), 60, "the stack read by soc-cloud")
        operation = await seed(admin, organization, pilot, so_stack)

        await ask(admin, pilot, operation, "plan")
        await reach(admin, operation, "planned", 15)
        await ask(admin, pilot, operation, "prepare")
        await reach(admin, operation, "preparing", 15)
        try:
            await until(
                lambda: blocking_checks_pass(admin, operation), 90, "every blocking check passing"
            )
        except AssertionError:
            print(await story(admin, operation))
            raise

        # The simulation: the file served to the stack, flown in the simulator.
        await ask(admin, pilot, operation, "simulate")
        await reach(admin, operation, "simulating", 15)

        async def flying() -> bool:
            latest = await latest_flight(admin, operation)
            return latest is not None and latest["status"] == "in_progress"

        await until(flying, 90, "the simulated flight in progress")
        flight = (await until(lambda: latest_flight(admin, operation), 5, "the flight"))["id"]
        wire, reply = [], []
        for _ in range(CYCLES):
            for verb in ("pause", "recovery"):
                answered = await settled(admin, await command(admin, pilot, flight, verb))
                assert answered["status"] == "accepted", (verb, answered["result"])
                wire.append(float(answered["wire_ms"]))
                reply.append(float(answered["reply_ms"]))
        print(
            f"{len(wire)} commands: to the wire p95 {p95(wire):.1f} ms,"
            f" to the reply p95 {p95(reply):.1f} ms"
        )
        assert p95(wire) <= 300
        assert p95(reply) <= 1000
        await reach(admin, operation, "simulated", 180)

        # The stack turned to real mode. The fake bridge's simulator stays on (SO's DEP-28), so
        # the operation is not ready: PF-SIMULATOR names it, and nothing goes to the wire.
        try:
            await asyncio.to_thread(so_stack.set_simulator_mode, False)

            async def simulator_named() -> bool:
                detail = await admin.fetchval(
                    "select detail from soc.operation_checks where operation_id = $1"
                    " and check_id = 'PF-SIMULATOR' and state = 'fail'",
                    operation,
                )
                return detail is not None and "simulator off" in detail

            await until(simulator_named, 60, "PF-SIMULATOR failing in real mode")
            mode = await admin.fetchval(
                "select state::text from soc.operation_checks where operation_id = $1"
                " and check_id = 'PF-MODE'",
                operation,
            )
            assert mode == "pass"
            await ask(admin, pilot, operation, "launch")

            async def launch_refused() -> list[str] | None:
                reasons = await admin.fetchval(
                    "select reasons from soc.transition_requests where operation_id = $1"
                    " and transition = 'launch' and status = 'refused'",
                    operation,
                )
                return None if reasons is None else list(json.loads(reasons))

            refusal = await until(launch_refused, 15, "the launch refused")
            print(f"launch refused: {refusal}")
            assert await state_of(admin, operation) == "simulated"
            launched = await admin.fetchval(
                "select count(*) from soc.flights where operation_id = $1 and mode = 'real'",
                operation,
            )
            assert launched == 0
        finally:
            await asyncio.to_thread(so_stack.set_simulator_mode, True)

        moves = [
            (row["from"], row["to"])
            for row in await admin.fetch(
                "select payload ->> 'from' as from, payload ->> 'to' as to"
                " from soc.operation_events where operation_id = $1"
                " and kind = 'operation_state_changed' order by recorded_at",
                operation,
            )
        ]
        assert moves == [
            ("draft", "planned"),
            ("planned", "preparing"),
            ("preparing", "simulating"),
            ("simulating", "simulated"),
        ]
        kinds = {
            row["kind"]
            for row in await admin.fetch(
                "select kind from soc.operation_events where operation_id = $1", operation
            )
        }
        assert {
            "checks_at_simulation",
            "flight_prepared",
            "flight_status_changed",
            "took_off",
            "automatic_return",
            "landed",
            "command_requested",
            "command_outcome",
            "flight_ended",
            "transition_refused",
        } <= kinds


async def test_a_restart_of_either_service_mid_flight_loses_nothing_and_sends_nothing_twice(
    platform: Platform,
    passwords: dict[str, str],
    so_stack: SoStack,
    admin: asyncpg.Connection,
    farm: Farm,
    tmp_path: Path,
) -> None:
    """NFR-REL-01: soc-cloud and soc-operations each stopped and started again while the
    simulated flight flies; the flight ends as it would have, and every command went out once."""
    organization, pilot = farm.organization, farm.pilot
    cloud = running_cloud(platform, passwords, so_stack, organization, tmp_path)
    operations = running_operations(platform, passwords, organization, tmp_path)
    await cloud.__aenter__()
    await operations.__aenter__()
    try:
        await until(lambda: stack_recorded(admin, so_stack), 60, "the stack read by soc-cloud")
        operation = await seed(admin, organization, pilot, so_stack)
        for transition, wanted in (("plan", "planned"), ("prepare", "preparing")):
            await ask(admin, pilot, operation, transition)
            await reach(admin, operation, wanted, 15)
        await until(
            lambda: blocking_checks_pass(admin, operation), 90, "every blocking check passing"
        )
        await ask(admin, pilot, operation, "simulate")

        async def flying() -> bool:
            latest = await latest_flight(admin, operation)
            return latest is not None and latest["status"] == "in_progress"

        await until(flying, 90, "the simulated flight in progress")
        flight = (await until(lambda: latest_flight(admin, operation), 5, "the flight"))["id"]

        # soc-cloud away for 3 s mid-flight: its persistent session keeps what the dock says.
        await cloud.__aexit__(None, None, None)
        await asyncio.sleep(3)
        cloud = running_cloud(platform, passwords, so_stack, organization, tmp_path)
        await cloud.__aenter__()
        # soc-operations away too, then back: its sweep finds what it missed.
        await operations.__aexit__(None, None, None)
        await asyncio.sleep(3)
        operations = running_operations(platform, passwords, organization, tmp_path)
        await operations.__aenter__()

        await reach(admin, operation, "simulated", 180)
    finally:
        await operations.__aexit__(None, None, None)
        await cloud.__aexit__(None, None, None)

    verbs = [
        row["verb"]
        for row in await admin.fetch(
            "select verb::text as verb from soc.command_intents where flight_id = $1"
            " order by requested_at",
            flight,
        )
    ]
    assert verbs == ["prepare", "execute"]
    ended = await admin.fetchrow(
        "select f.end_reason::text as reason, s.status::text as status from soc.flights f"
        " join soc.flight_states s on s.flight_id = f.id where f.id = $1",
        flight,
    )
    assert ended is not None and (ended["status"], ended["reason"]) == ("ok", "completed")
    kept = await admin.fetchval(
        "select count(*) from soc.telemetry_samples where flight_id = $1", flight
    )
    assert kept > 0
