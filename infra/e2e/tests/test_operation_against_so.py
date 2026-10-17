"""An operation flown against Sky Orchestrator's released stack and its fake bridge (M4).

SOC as it runs: soc-cloud and soc-operations in this process, on Virtual Origen's platform,
against a throwaway Sky Orchestrator stack with the fake bridge standing in for the phone. A
pilot asks every move through the database's RPCs, as the console does:

- plan, prepare, and the real checks judged on what soc-cloud reads from the stack, until
  every blocking one passes, Sky Orchestrator's dry run included;
- simulate: the flight file served to the stack, the simulated flight flown, paused and
  resumed 50 times while it flies (NFR-PERF-02's 100 commands), and ended ok;
- the stack turned to real mode with the phone's simulator still on: PF-MODE passes,
  PF-SIMULATOR fails, and the launch is refused before anything reaches the wire;
- the phone launched ready for real flight (SO's DEP-28): the operation is ready, launches,
  is paused and resumed in the air, and completes once the aircraft has landed, its return
  home no higher than the prepare's return height asked (SO's DEP-29).

Every move is in the operation's log, and each command's latency is measured: to the wire
and to its reply. The same flight worked in Chrome is test_console_operation_against_so.py.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_database.harness import Tenancy
from soc_e2e.operations import (
    FARM,
    HIGHEST_WAYPOINT_M,
    RETURN_HEIGHT_M,
    WAYLINE_MODE,
    ask,
    blocking_checks_pass,
    command,
    latest_flight,
    p95,
    reach,
    running_cloud,
    running_operations,
    seed,
    settled,
    stack_recorded,
    state_of,
    story,
    until,
)
from soc_e2e.platform import Platform
from soc_e2e.so_stack import SoStack
from soc_operations.testing import FLIGHT

pytestmark = [pytest.mark.lane, pytest.mark.sky_orchestrator]

CYCLES = 50
#: Pauses and resumes in the real flight: the command latency is measured on the simulated one.
REAL_CYCLES = 3
#: The index of the golden flight's last waypoint, which its route ends at.
LAST_WAYPOINT = len(FLIGHT["waypoints"]) - 1


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


async def follow_waypoints(
    platform: Platform, flight: uuid.UUID, seen: list[tuple[str, int]]
) -> None:
    """Appends each new status and waypoint index the flight's state records, until cancelled."""
    connection = await platform.stack.postgres.connect("supabase_admin")
    try:
        while True:
            row = await connection.fetchrow(
                "select status::text as status, current_waypoint_index as index"
                " from soc.flight_states where flight_id = $1",
                flight,
            )
            if row is not None and row["index"] is not None:
                state = (str(row["status"]), int(row["index"]))
                if not seen or seen[-1] != state:
                    seen.append(state)
            await asyncio.sleep(0.1)
    finally:
        await connection.close()


async def test_an_operation_is_simulated_then_flown_real_paused_resumed_and_completed(
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
        # FR-CMD-02: the waypoint index, followed through the whole flight on a connection of
        # its own, from the first pause to the end, never goes back.
        followed: list[tuple[str, int]] = []
        following = asyncio.create_task(follow_waypoints(platform, flight, followed))
        wire, reply = [], []
        try:
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
        finally:
            following.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await following
        print(f"status and waypoint index through the flight: {followed}")
        # Over the whole execution, the finish action's return home included, the index never
        # goes back, and it holds the last waypoint once the route is over (flighttask_progress
        # 1.2.0, Sky Orchestrator v0.4.4).
        indices = [index for _, index in followed]
        assert indices == sorted(indices), f"the waypoint index went back: {followed}"
        assert indices[-1] == LAST_WAYPOINT, "the flight did not end at its last waypoint"

        # The stack turned to real mode with the phone's simulator still on: the operation is
        # not ready, PF-SIMULATOR names why, and nothing goes to the wire.
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

            # The phone launched ready for real flight: so-fleet still holds the simulation of
            # this file, so the operation is ready, and the same file flies real.
            await asyncio.to_thread(so_stack.set_real_launch, True)
            await reach(admin, operation, "ready", 90)
            await ask(admin, pilot, operation, "launch")
            await reach(admin, operation, "in_flight", 60)
            real = await until(lambda: latest_flight(admin, operation), 5, "the real flight")
            assert real["mode"] == "real"

            # A pause is taken once the mission drives the aircraft: during the take-off the
            # application refuses it (319046), as SO's own fly.py waits for the route.
            async def on_the_route() -> bool:
                mode = await admin.fetchval(
                    "select mode_code from soc.telemetry_samples where flight_id = $1"
                    " order by sampled_at desc limit 1",
                    real["id"],
                )
                return bool(mode == WAYLINE_MODE)

            await until(on_the_route, 60, "the real flight on its route")
            for _ in range(REAL_CYCLES):
                paused = await settled(admin, await command(admin, pilot, real["id"], "pause"))
                assert paused["status"] == "accepted", paused["result"]
                await reach(admin, operation, "paused", 15)
                resumed = await settled(admin, await command(admin, pilot, real["id"], "recovery"))
                assert resumed["status"] == "accepted", resumed["result"]
                await reach(admin, operation, "in_flight", 15)
            await reach(admin, operation, "completed", 240)
        finally:
            await asyncio.to_thread(so_stack.set_real_launch, False)

        flown = await admin.fetchrow(
            "select f.end_reason::text as reason, f.breached_at, s.status::text as status,"
            " (select max(t.height_m) from soc.telemetry_samples t where t.flight_id = f.id)"
            " as highest from soc.flights f join soc.flight_states s on s.flight_id = f.id"
            " where f.id = $1",
            real["id"],
        )
        assert flown is not None
        assert (flown["status"], flown["reason"], flown["breached_at"]) == ("ok", "completed", None)
        # The return home climbs no higher than the route's highest waypoint or the return height
        # asked, never to the envelope's 100 m (DEP-29): a sample's height is above the takeoff.
        print(f"the real flight's highest sample: {flown['highest']} m")
        assert flown["highest"] <= max(HIGHEST_WAYPOINT_M, RETURN_HEIGHT_M) + 0.5

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
            ("simulated", "ready"),
            ("ready", "launching"),
            ("launching", "in_flight"),
            *[("in_flight", "paused"), ("paused", "in_flight")] * REAL_CYCLES,
            ("in_flight", "returning"),
            ("returning", "completed"),
        ]
        kinds = {
            row["kind"]
            for row in await admin.fetch(
                "select kind from soc.operation_events where operation_id = $1", operation
            )
        }
        assert {
            "checks_at_simulation",
            "checks_at_launch",
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


async def restart_both(
    platform: Platform,
    passwords: dict[str, str],
    so: SoStack,
    organization: uuid.UUID,
    directory: Path,
    services: list[Any],
) -> None:
    """soc-cloud away for 3 s, then soc-operations: each started again on its own state."""
    cloud, operations = services
    # soc-cloud away for 3 s mid-flight: its persistent session keeps what the dock says.
    await cloud.__aexit__(None, None, None)
    await asyncio.sleep(3)
    services[0] = running_cloud(platform, passwords, so, organization, directory)
    await services[0].__aenter__()
    # soc-operations away too, then back: its sweep finds what it missed.
    await operations.__aexit__(None, None, None)
    await asyncio.sleep(3)
    services[1] = running_operations(platform, passwords, organization, directory)
    await services[1].__aenter__()


async def flown_once(admin: asyncpg.Connection, flight: uuid.UUID) -> None:
    """The flight went out once, ended ok and completed, and kept its track."""
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


async def test_a_restart_of_either_service_mid_flight_loses_nothing_and_sends_nothing_twice(
    platform: Platform,
    passwords: dict[str, str],
    so_stack: SoStack,
    admin: asyncpg.Connection,
    farm: Farm,
    tmp_path: Path,
) -> None:
    """NFR-REL-01: soc-cloud and soc-operations each stopped and started again while the
    simulated flight flies, and again while the real one does; each flight ends as it would
    have, and every command went out once."""
    organization, pilot = farm.organization, farm.pilot
    services: list[Any] = [
        running_cloud(platform, passwords, so_stack, organization, tmp_path),
        running_operations(platform, passwords, organization, tmp_path),
    ]
    await services[0].__aenter__()
    await services[1].__aenter__()
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
        simulated = (await until(lambda: latest_flight(admin, operation), 5, "the flight"))["id"]
        await restart_both(platform, passwords, so_stack, organization, tmp_path, services)
        await reach(admin, operation, "simulated", 180)

        try:
            await asyncio.to_thread(so_stack.set_real_launch, True)
            await reach(admin, operation, "ready", 90)
            await ask(admin, pilot, operation, "launch")
            await reach(admin, operation, "in_flight", 60)
            real = (await until(lambda: latest_flight(admin, operation), 5, "the flight"))["id"]
            await restart_both(platform, passwords, so_stack, organization, tmp_path, services)
            await reach(admin, operation, "completed", 240)
        finally:
            await asyncio.to_thread(so_stack.set_real_launch, False)
    finally:
        await services[1].__aexit__(None, None, None)
        await services[0].__aexit__(None, None, None)

    assert real != simulated
    await flown_once(admin, simulated)
    await flown_once(admin, real)
