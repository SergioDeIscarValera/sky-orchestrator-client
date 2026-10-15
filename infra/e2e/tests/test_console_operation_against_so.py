"""An operation flown from the console, in Chrome, against Sky Orchestrator's released stack (M4).

The flight test_operation_against_so.py flies through the database's RPCs, worked here as a pilot
works it in the web console: operation.mjs drives Chrome against the console's own image. The
pilot plans and prepares the operation, the checks are judged until every blocking one passes,
and the pilot simulates. While the simulated flight flies, the pilot pauses and resumes it 50
times: 100 commands, each reply shown timed in the page from its send (NFR-PERF-02). The harness
then turns the stack to a real launch, the phone ready for real flight, and the pilot launches,
pauses and resumes the aircraft in the air until it completes. The log, as the console shows it,
and the database's moves both read draft to completed, in order.
"""

from __future__ import annotations

import asyncio
import secrets
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_check import Image
from soc_database.harness import Tenancy
from soc_e2e.console import OPERATION_DRIVER, Browser, browsing, serving
from soc_e2e.operations import (
    FARM,
    HIGHEST_WAYPOINT_M,
    RETURN_HEIGHT_M,
    WAYLINE_MODE,
    p95,
    running_cloud,
    running_operations,
    seed,
    stack_recorded,
    story,
    until,
)
from soc_e2e.platform import Platform
from soc_e2e.so_stack import SoStack

pytestmark = [pytest.mark.lane, pytest.mark.sky_orchestrator]

#: The simulated flight runs at real time, so the route lasts as long on the wall clock. Each cycle
#: takes about four seconds of it, the holds and their replies (25 cycles took 99 s).
PACE = 1
#: The route is flown at 1 m/s, not the golden flight's 5 m/s: at 5 m/s the route is 23 s of flight,
#: too short for the cycles. At 1 m/s it is over two minutes, and the flight is still in the air
#: after the last cycle.
FLIGHT_SPEED_MS = 1.0
CYCLES = 50
#: NFR-PERF-02: the reply to a command is shown within one second, at p95.
REPLY_P95_MS = 1000
#: FR-CMD-07: a command goes out once its button has been held for 1.5 s.
HOLD_MS = 1500
SIMULATED_WITHIN_S = 900
REAL_WITHIN_S = 600
ON_ROUTE_WITHIN_S = 240
COMPLETED_WITHIN_S = 900

#: The console's words for the operation's states (apps/soc-web/src/operations/format.ts).
WORDS = {
    "draft": "Draft",
    "planned": "Planned",
    "preparing": "Preparing",
    "simulating": "Simulating",
    "simulated": "Simulated",
    "ready": "Ready",
    "launching": "Launching",
    "in_flight": "In flight",
    "paused": "Paused",
    "returning": "Returning",
    "completed": "Completed",
}
#: The moves from draft to completed: the simulated flight is not a state of its own, and the real
#: flight is paused and resumed once.
MOVES = [
    ("draft", "planned"),
    ("planned", "preparing"),
    ("preparing", "simulating"),
    ("simulating", "simulated"),
    ("simulated", "ready"),
    ("ready", "launching"),
    ("launching", "in_flight"),
    ("in_flight", "paused"),
    ("paused", "in_flight"),
    ("in_flight", "returning"),
    ("returning", "completed"),
]
#: Each move as the log's entry reads once the console has shown it: "State changed · Draft to
#: Planned", less its prefix.
SHOWN = [f"{WORDS[before]} to {WORDS[after]}" for before, after in MOVES]


@pytest.fixture(scope="module")
def so_stack() -> Iterator[SoStack]:
    stack = SoStack(site=FARM, pace=PACE)
    try:
        stack.start()
        yield stack
    except BaseException:
        print(stack.logs())
        raise
    finally:
        stack.stop()


async def test_an_operation_is_flown_from_the_console_against_sky_orchestrator(
    platform: Platform,
    passwords: dict[str, str],
    console_image: Image,
    so_stack: SoStack,
    admin: asyncpg.Connection,
    tmp_path: Path,
) -> None:
    email = f"pilot-{secrets.token_hex(4)}@soc.test"
    secret = secrets.token_hex(16)
    pilot = platform.create_user(email, secret)
    organization = await own_farm(admin, pilot, email)
    (tmp_path / "web").mkdir()
    async with (
        running_cloud(platform, passwords, so_stack, organization, tmp_path),
        running_operations(platform, passwords, organization, tmp_path),
    ):
        await until(lambda: stack_recorded(admin, so_stack), 60, "the stack read by soc-cloud")
        operation = await seed(admin, organization, pilot, so_stack, speed_ms=FLIGHT_SPEED_MS)
        with serving(console_image, platform.url, platform.anon_key(), tmp_path / "web") as url:
            environment = {
                "SOC_E2E_CONSOLE": url,
                "SOC_E2E_EMAIL": email,
                "SOC_E2E_PASSWORD": secret,
                "SOC_E2E_OPERATION": str(operation),
                "SOC_E2E_CYCLES": str(CYCLES),
                "SOC_E2E_SHOTS": str(tmp_path / "shots"),
            }
            async with browsing(environment, OPERATION_DRIVER) as browser:
                try:
                    simulated, completed, real = await fly_from_the_console(
                        browser, so_stack, admin, operation
                    )
                except AssertionError, RuntimeError, TimeoutError:
                    print(await story(admin, operation))
                    print(await dry_runs_of(admin, operation))
                    raise

    latencies = [float(value) for value in simulated["latencies_ms"]]
    holds = [float(value) for value in simulated["holds_ms"]]
    assert len(latencies) == 2 * CYCLES, len(latencies)
    print(
        f"{len(latencies)} commands in {CYCLES} cycles: reply shown p95 {p95(latencies):.1f} ms,"
        f" worst {max(latencies):.1f} ms; the holds at least {min(holds):.1f} ms"
    )
    # A command goes out only once its button has been held for the whole 1.5 s (FR-CMD-07).
    assert min(holds) >= HOLD_MS - 5, holds
    # NFR-PERF-02: the reply to a command is shown within a second, at p95.
    assert p95(latencies) <= REPLY_P95_MS, latencies

    # The log as the console shows it holds every move, draft to completed, in order.
    assert completed["state_changes"] == SHOWN, completed["state_changes"]
    # The database holds the same moves, in the same order.
    moves = [
        (row["from"], row["to"])
        for row in await admin.fetch(
            "select payload ->> 'from' as from, payload ->> 'to' as to"
            " from soc.operation_events where operation_id = $1"
            " and kind = 'operation_state_changed' order by recorded_at",
            operation,
        )
    ]
    assert moves == MOVES, moves
    # The real flight ended ok and completed, and its return home kept to the return height asked.
    flown = await admin.fetchrow(
        "select f.end_reason::text as reason, f.breached_at, s.status::text as status,"
        " (select max(t.height_m) from soc.telemetry_samples t where t.flight_id = f.id)"
        " as highest from soc.flights f join soc.flight_states s on s.flight_id = f.id"
        " where f.id = $1",
        real,
    )
    assert flown is not None
    assert (flown["status"], flown["reason"], flown["breached_at"]) == ("ok", "completed", None)
    print(f"the real flight's highest sample: {flown['highest']} m")
    assert flown["highest"] <= max(HIGHEST_WAYPOINT_M, RETURN_HEIGHT_M) + 0.5


async def fly_from_the_console(
    browser: Browser, so_stack: SoStack, admin: asyncpg.Connection, operation: uuid.UUID
) -> tuple[dict[str, Any], dict[str, Any], uuid.UUID]:
    """The browser's flight, and the harness's half of it: the simulation the browser reports,
    the stack turned to a real launch once it has, the real flight found on its route, and the
    completion the browser reports once it has landed. Returns the simulation, the completion and
    the real flight."""
    await browser.expect("ready")
    simulated = await browser.expect("simulated", SIMULATED_WITHIN_S)
    await asyncio.to_thread(so_stack.set_real_launch, True)
    await browser.tell(real=True)
    real: uuid.UUID = await until(
        lambda: real_flight(admin, operation), REAL_WITHIN_S, "the real flight prepared"
    )
    await until(
        lambda: on_the_route(admin, real), ON_ROUTE_WITHIN_S, "the real flight on its route"
    )
    await browser.tell(on_route=True)
    completed = await browser.expect("completed", COMPLETED_WITHIN_S)
    return simulated, completed, real


async def dry_runs_of(admin: asyncpg.Connection, operation: uuid.UUID) -> str:
    """The dry runs of the operation's flight files, to read when a check does not pass."""
    rows = await admin.fetch(
        "select d.file_id, d.status::text as status, d.requested_at, d.judged_at, f.created_at"
        " from soc.dry_runs d join soc.flight_files f on f.id = d.file_id"
        " where f.operation_id = $1 order by d.requested_at",
        operation,
    )
    if not rows:
        return "no dry run"
    return "\n".join(
        f"dry run {row['file_id']} {row['status']} requested {row['requested_at']}"
        f" judged {row['judged_at']}; its file made {row['created_at']}"
        for row in rows
    )


async def own_farm(admin: asyncpg.Connection, pilot: uuid.UUID, email: str) -> uuid.UUID:
    """The pilot's profile, and Finca Norte, which they own: the organization the stack serves."""
    await admin.execute(
        "insert into public.profiles (id, display_name, email) values ($1, 'Pilot', $2)",
        pilot,
        email,
    )
    return await Tenancy(admin).organization(
        pilot,
        name="Finca Norte",
        position=(FARM.latitude_deg, FARM.longitude_deg),
        timezone="Europe/Madrid",
    )


async def real_flight(admin: asyncpg.Connection, operation: uuid.UUID) -> uuid.UUID | None:
    """The operation's real flight, once its launch has prepared one."""
    flight: uuid.UUID | None = await admin.fetchval(
        "select id from soc.flights where operation_id = $1 and mode = 'real'"
        " order by prepared_at desc limit 1",
        operation,
    )
    return flight


async def on_the_route(admin: asyncpg.Connection, flight: uuid.UUID) -> bool:
    """Whether the aircraft's latest sample says it flies its wayline (mode 5)."""
    mode = await admin.fetchval(
        "select mode_code from soc.telemetry_samples where flight_id = $1"
        " order by sampled_at desc limit 1",
        flight,
    )
    return bool(mode == WAYLINE_MODE)
