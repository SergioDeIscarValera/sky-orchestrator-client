"""An operation's whole life against the database, soc-operations running (FR-OPS-02 to FR-OPS-10).

soc-cloud's part is played through its own database functions: it replies to each command,
records the flight's progress and the aircraft's take-off and landing, as it does on the
wire. The checks are judged by a stub here, all passing; soc_operations.checks is held by
its own tests. What this proves is the lifecycle's plumbing: each request decided, each
move made by the database's only way, each command asked, the log written as it went.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_config import Contract
from soc_database.harness import EphemeralPostgres, Tenancy, impersonate
from soc_operations import settings, store
from soc_operations.judging import judged
from soc_operations.runner import Runner
from soc_operations.testing import ENVELOPE, FLIGHT, ROUTE, SQUARE

pytestmark = pytest.mark.lane

FINGERPRINT = "f" * 64
FILES_URL = "http://soc-cloud:8081"


@dataclass(frozen=True)
class Passing:
    check_id: str
    state: str = "pass"
    blocking: bool = True
    detail: str = "passes"
    value: Any = None


def all_pass(_loaded: store.Loaded, _tunables: Any, _now: datetime) -> Sequence[Passing]:
    return [Passing("PF-LINK"), Passing("PF-BATTERY")]


@dataclass
class Seeded:
    organization_id: uuid.UUID
    pilot: uuid.UUID
    gateway: str
    operation_id: uuid.UUID


@pytest.fixture
async def admin(migrated: EphemeralPostgres) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("supabase_admin")
    try:
        yield connection
    finally:
        await connection.close()


async def seed(admin: asyncpg.Connection) -> Seeded:
    """Finca Norte's route, its fleet, a geofence round it, a draft assigning them."""
    member = await Tenancy(admin).member("owner")
    gateway, aircraft = (
        f"SOTEST{uuid.uuid4().hex[:8].upper()}",
        f"UAV{uuid.uuid4().hex[:8].upper()}",
    )
    organization = member.organization_id
    await admin.execute(
        "select soc.record_stack($1, 'lab', $2, 'connected')", gateway, organization
    )
    await admin.execute(
        "select soc.record_topology($1, $2::jsonb)",
        gateway,
        json.dumps(
            [{"aircraft_sn": aircraft, "domain": 0, "type": 67, "sub_type": 0, "online": True}]
        ),
    )
    await admin.execute("select soc.record_stack_files_url($1, $2)", gateway, FILES_URL)
    await admin.execute(
        "select soc.record_stack_envelope($1, $2::jsonb)", gateway, json.dumps(ENVELOPE)
    )
    await status(admin, gateway, simulator_mode=True)
    model = await admin.fetchval("select model from soc.aircraft_models order by model limit 1")
    fleet = await admin.fetchval(
        "insert into soc.fleets (organization_id, name, model, airframe_serial, gateway_sn,"
        " aircraft_sn) values ($1, 'Norte 1', $2, '1WNBH9', $3, $4) returning id",
        organization, model, gateway, aircraft,
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
        operation, organization, member.user_id,
    )  # fmt: skip
    return Seeded(organization, member.user_id, gateway, operation)


async def status(admin: asyncpg.Connection, gateway: str, *, simulator_mode: bool) -> None:
    said = {
        "simulator_mode": simulator_mode,
        "simulator_active": simulator_mode,
        "link": {"state": "up", "reason": None, "changed_at_ms": 1},
        "config_fingerprint": FINGERPRINT,
    }
    await admin.execute("select soc.record_stack_status($1, $2::jsonb)", gateway, json.dumps(said))


async def ask(admin: asyncpg.Connection, seeded: Seeded, transition: str) -> uuid.UUID:
    """The pilot asks, as the browser would through its RPC."""
    async with admin.transaction():
        await impersonate(admin, seeded.pilot)
        request = await admin.fetchval(
            "select id from soc.request_transition($1, $2::soc.transition, $3)",
            seeded.operation_id, transition, uuid.uuid4(),
        )  # fmt: skip
    assert isinstance(request, uuid.UUID)
    return request


async def until(probe: Callable[[], Any], within_s: float = 10.0) -> Any:
    async with asyncio.timeout(within_s):
        while True:
            value = await probe()
            if value:
                return value
            await asyncio.sleep(0.05)


async def state_of(admin: asyncpg.Connection, operation: uuid.UUID) -> str:
    return str(await admin.fetchval("select state from soc.operations where id = $1", operation))


async def reached(admin: asyncpg.Connection, operation: uuid.UUID, wanted: str) -> None:
    async def probe() -> bool:
        return await state_of(admin, operation) == wanted

    await until(probe)


async def answer(
    admin: asyncpg.Connection, operation: uuid.UUID, verb: str, result: int = 0
) -> uuid.UUID:
    """soc-cloud's part: the command sent and Sky Orchestrator's reply recorded."""

    async def pending() -> Any:
        return await admin.fetchrow(
            "select id, flight_id, payload from soc.command_intents"
            " where operation_id = $1 and verb = $2::soc.command_verb and status = 'pending'",
            operation, verb,
        )  # fmt: skip

    intent = await until(pending)
    await admin.execute("select * from soc.claim_command_intent($1, 60)", intent["id"])
    await admin.execute("select * from soc.record_command_reply($1, $2)", intent["id"], result)
    flight: uuid.UUID = intent["flight_id"]
    return flight


def runner_of(
    migrated: EphemeralPostgres,
    passwords: dict[str, str],
    tmp_path: Path,
    judge: Any,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Runner:
    path = tmp_path / "soc-operations.json"
    starting = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
    }
    path.write_text(json.dumps(starting), encoding="utf-8")
    loaded = settings.load(
        {
            "SOC_CONFIG_FILE": str(path),
            "SOC_HEALTH_PORT": "8080",
            "SOC_DB_HOST": "127.0.0.1",
            "SOC_DB_PORT": str(migrated.port),
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_OPERATIONS": passwords["soc_operations"],
        }
    )
    return Runner(loaded.database, loaded.tunables, judge, clock=clock, tick_s=0.1)


@pytest.fixture
async def judging(
    migrated: EphemeralPostgres, passwords: dict[str, str], tmp_path: Path
) -> AsyncIterator[None]:
    task = asyncio.create_task(runner_of(migrated, passwords, tmp_path, judged).run())
    try:
        yield
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.fixture
async def running(
    migrated: EphemeralPostgres, passwords: dict[str, str], tmp_path: Path
) -> AsyncIterator[None]:
    task = asyncio.create_task(runner_of(migrated, passwords, tmp_path, all_pass).run())
    try:
        yield
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_an_operation_flies_from_draft_to_completed(
    admin: asyncpg.Connection, running: None
) -> None:
    del running
    seeded = await seed(admin)
    operation = seeded.operation_id

    await ask(admin, seeded, "plan")
    await reached(admin, operation, "planned")
    await ask(admin, seeded, "prepare")
    await reached(admin, operation, "preparing")
    file = await admin.fetchrow(
        "select id, md5, token from soc.flight_files where operation_id = $1", operation
    )
    assert file is not None
    assert (
        await admin.fetchval("select count(*) from soc.dry_runs where file_id = $1", file["id"])
        == 1
    )

    # The simulated pass (FR-OPS-06): prepared in the simulator, executed, ended ok.
    await ask(admin, seeded, "simulate")
    await reached(admin, operation, "simulating")
    prepare = await admin.fetchval(
        "select payload from soc.command_intents where operation_id = $1 and verb = 'prepare'",
        operation,
    )
    payload = json.loads(prepare)
    assert payload["simulate_mission"]["is_enable"] == 1
    assert payload["file"] == {
        "url": f"{FILES_URL}/files/{file['token']}.kmz",
        "fingerprint": file["md5"],
    }
    simulated = await answer(admin, operation, "prepare")
    await answer(admin, operation, "execute")
    await admin.execute(
        "select soc.record_flight_progress($1, 'ok', 0, 100, 6, null, 'completed')", simulated
    )
    await reached(admin, operation, "simulated")

    # Real mode under the same phone configuration: ready (FR-OPS-07).
    await status(admin, seeded.gateway, simulator_mode=False)
    await reached(admin, operation, "ready")

    # The launch (FR-OPS-09), the flight, and its close on the ground (FR-OPS-10).
    await ask(admin, seeded, "launch")
    await reached(admin, operation, "launching")
    real = await answer(admin, operation, "prepare")
    assert real != simulated
    await answer(admin, operation, "execute")
    await reached(admin, operation, "in_flight")
    await admin.execute("select soc.record_flight_moment($1, 'took_off', now(), 4)", real)
    await admin.execute(
        "select soc.record_flight_progress($1, 'ok', 0, 100, 6, null, 'completed')", real
    )
    await reached(admin, operation, "returning")
    await admin.execute("select soc.record_flight_moment($1, 'landed', now(), 0)", real)
    await reached(admin, operation, "completed")

    modes = await admin.fetch(
        "select mode::text, end_reason::text from soc.flights where operation_id = $1"
        " order by prepared_at",
        operation,
    )
    assert [(row["mode"], row["end_reason"]) for row in modes] == [
        ("simulated", "completed"),
        ("real", "completed"),
    ]
    ended = await admin.fetch(
        "select payload ->> 'end_reason' as reason from soc.operation_events"
        " where operation_id = $1 and kind = 'flight_ended' order by recorded_at",
        operation,
    )
    assert [row["reason"] for row in ended] == ["completed", "completed"]
    moves = await admin.fetch(
        "select payload ->> 'to' as moved from soc.operation_events"
        " where operation_id = $1 and kind = 'operation_state_changed' order by recorded_at",
        operation,
    )
    assert [row["moved"] for row in moves] == [
        "planned", "preparing", "simulating", "simulated", "ready", "launching", "in_flight",
        "returning", "completed",
    ]  # fmt: skip


async def test_a_refusal_is_decided_with_its_reasons_and_moves_nothing(
    admin: asyncpg.Connection, running: None
) -> None:
    del running
    seeded = await seed(admin)
    await admin.execute(
        "update soc.assignments set flight = null where operation_id = $1", seeded.operation_id
    )
    request = await ask(admin, seeded, "plan")

    async def decided() -> Any:
        return await admin.fetchrow(
            "select status::text, reasons from soc.transition_requests where id = $1"
            " and status not in ('pending', 'running')",
            request,
        )

    row = await until(decided)
    assert row["status"] == "refused"
    assert "the wayline has not been flown for this operation yet" in json.loads(row["reasons"])
    assert await state_of(admin, seeded.operation_id) == "draft"


async def test_a_refused_launch_returns_to_ready_with_sky_orchestrators_meaning(
    admin: asyncpg.Connection, running: None
) -> None:
    del running
    seeded = await seed(admin)
    operation = seeded.operation_id
    for transition, wanted in (
        ("plan", "planned"),
        ("prepare", "preparing"),
        ("simulate", "simulating"),
    ):
        await ask(admin, seeded, transition)
        await reached(admin, operation, wanted)
    simulated = await answer(admin, operation, "prepare")
    await answer(admin, operation, "execute")
    await admin.execute(
        "select soc.record_flight_progress($1, 'ok', 0, 100, 6, null, 'completed')", simulated
    )
    await reached(admin, operation, "simulated")
    await status(admin, seeded.gateway, simulator_mode=False)
    await reached(admin, operation, "ready")
    await ask(admin, seeded, "launch")
    await reached(admin, operation, "launching")
    await answer(admin, operation, "prepare", result=314010)
    await reached(admin, operation, "ready")
    cause = await admin.fetchval(
        "select payload ->> 'cause' from soc.operation_events where operation_id = $1"
        " and kind = 'operation_state_changed' and payload ->> 'to' = 'ready'"
        " order by recorded_at desc limit 1",
        operation,
    )
    assert "has not completed a simulation on this stack" in cause


async def test_the_real_checks_are_written_and_gate_the_simulation(
    admin: asyncpg.Connection, judging: None
) -> None:
    """FR-OPS-04, FR-OPS-05: preparing writes the sixteen checks, and with no aircraft sample
    yet the simulated pass is refused naming every blocking check that is not passing."""
    del judging
    seeded = await seed(admin)
    operation = seeded.operation_id
    await ask(admin, seeded, "plan")
    await reached(admin, operation, "planned")
    await ask(admin, seeded, "prepare")
    await reached(admin, operation, "preparing")

    async def sixteen() -> bool:
        count = await admin.fetchval(
            "select count(*) from soc.operation_checks where operation_id = $1", operation
        )
        return bool(count == 16)

    await until(sixteen)
    unknown = await admin.fetchval(
        "select state::text from soc.operation_checks where operation_id = $1"
        " and check_id = 'PF-FRESH'",
        operation,
    )
    assert unknown == "unknown"
    request = await ask(admin, seeded, "simulate")

    async def decided() -> Any:
        return await admin.fetchrow(
            "select status::text, reasons from soc.transition_requests where id = $1"
            " and status not in ('pending', 'running')",
            request,
        )

    row = await until(decided)
    assert row["status"] == "refused"
    assert any(reason.startswith("PF-FRESH") for reason in json.loads(row["reasons"]))
    assert await state_of(admin, operation) == "preparing"


async def test_an_execute_with_an_unknown_outcome_waits_then_goes_back_undone(
    admin: asyncpg.Connection,
    migrated: EphemeralPostgres,
    passwords: dict[str, str],
    tmp_path: Path,
) -> None:
    """DEP-27: 319999 moves nothing; with no progress 10 s after, the flight never started."""
    ahead = [timedelta()]
    runner = runner_of(
        migrated, passwords, tmp_path, all_pass, clock=lambda: datetime.now(UTC) + ahead[0]
    )
    task = asyncio.create_task(runner.run())
    try:
        seeded = await seed(admin)
        operation = seeded.operation_id
        for transition, wanted in (
            ("plan", "planned"),
            ("prepare", "preparing"),
            ("simulate", "simulating"),
        ):
            await ask(admin, seeded, transition)
            await reached(admin, operation, wanted)
        flight = await answer(admin, operation, "prepare")
        await answer(admin, operation, "execute", result=319999)
        await asyncio.sleep(0.5)
        assert await state_of(admin, operation) == "simulating"
        outcome = await admin.fetchval(
            "select source::text from soc.operation_events where operation_id = $1"
            " and kind = 'command_outcome' and payload ->> 'result' = '319999'",
            operation,
        )
        assert outcome == "soc-cloud"
        ahead[0] = timedelta(seconds=11)
        await reached(admin, operation, "preparing")
        undo = await admin.fetchval(
            "select payload from soc.command_intents"
            " where flight_id = $1 and verb = 'undo' and status = 'pending'",
            flight,
        )
        assert json.loads(undo) == {"flight_ids": [str(flight)]}
        ended = await admin.fetchrow(
            "select ended_at, end_reason::text as reason from soc.flights where id = $1", flight
        )
        assert ended is not None and ended["ended_at"] is not None
        assert ended["reason"] == "cancelled"
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
