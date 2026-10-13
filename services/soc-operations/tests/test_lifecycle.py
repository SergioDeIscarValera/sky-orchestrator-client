"""The lifecycle's decisions, from a snapshot to actions (FR-OPS-02 to FR-OPS-10, FR-CMD-03/04)."""

from __future__ import annotations

import dataclasses
import uuid
from dataclasses import dataclass
from typing import Any

import pytest

from soc_operations.lifecycle import (
    BuildFile,
    Command,
    EndFlight,
    Executed,
    File,
    Flight,
    FlightState,
    Log,
    Move,
    Outcome,
    PrepareFlight,
    Snapshot,
    on_checks,
    on_outcome,
    on_progress,
    on_request,
)
from soc_operations.testing import ENVELOPE, operation

FINGERPRINT = "a" * 64
FILE = File(id=uuid.uuid4(), md5="0" * 32, token="t" * 22)


@dataclass(frozen=True)
class Judged:
    check_id: str
    state: str
    blocking: bool
    detail: str


PASSING = [Judged("PF-LINK", "pass", True, "connected"), Judged("PF-CLOCK", "fail", False, "far")]
FAILING = [Judged("PF-BATTERY", "fail", True, "battery 12 % under 30 %"), *PASSING]


def status(**changes: Any) -> dict[str, Any]:
    return {
        "simulator_mode": True,
        "simulator_active": True,
        "link": {"state": "up", "reason": None, "changed_at_ms": 1},
        "config_fingerprint": FINGERPRINT,
        **changes,
    }


def flight(**changes: Any) -> Flight:
    base = Flight(
        id=uuid.uuid4(), mode="simulated", file_id=FILE.id, config_fingerprint=FINGERPRINT,
        executed=False, took_off=False, landed=False, ended=False, state=None,
    )  # fmt: skip
    return dataclasses.replace(base, **changes)


def snapshot(state: str, **changes: Any) -> Snapshot:
    base = Snapshot(
        operation_id=uuid.uuid4(), state=state, view=operation(), status=status(),
        envelope=ENVELOPE, flight_files_url="http://soc-cloud:8081", file=FILE, flights=(),
        stopped=False,
    )  # fmt: skip
    return dataclasses.replace(base, **changes)


def moves(decision: Any) -> list[str]:
    return [action.to for action in decision.actions if isinstance(action, Move)]


# --- Requests -----------------------------------------------------------------------------


def test_plan_moves_a_valid_draft_and_refuses_naming_every_problem() -> None:
    assert moves(on_request(snapshot("draft"), "plan", [])) == ["planned"]
    bare = snapshot("draft", view=operation(takeoff_security_height_m=None, pilots=0))
    decision = on_request(bare, "plan", [])
    assert not decision.accepted
    assert {
        "the operation has no height",
        "the operation has no pilot who is an editor of its organization",
    } <= set(decision.reasons)
    assert not on_request(snapshot("planned"), "plan", []).accepted


def test_prepare_builds_the_file_then_moves_and_unprepare_goes_back() -> None:
    decision = on_request(snapshot("planned"), "prepare", [])
    assert decision.actions == (BuildFile(), Move("preparing", "prepare"))
    assert moves(on_request(snapshot("preparing"), "unprepare", [])) == ["planned"]
    assert not on_request(snapshot("draft"), "prepare", []).accepted


@pytest.mark.parametrize("state", ["draft", "planned", "preparing", "simulated", "ready"])
def test_cancel_closes_an_operation_that_has_not_flown(state: str) -> None:
    assert moves(on_request(snapshot(state), "cancel", [])) == ["cancelled"]


@pytest.mark.parametrize("state", ["simulating", "launching", "in_flight", "paused", "returning"])
def test_cancel_is_refused_once_it_flies(state: str) -> None:
    assert not on_request(snapshot(state), "cancel", []).accepted


def test_simulate_prepares_the_same_file_in_the_simulator_with_every_blocking_check_passing() -> (
    None
):
    decision = on_request(snapshot("preparing"), "simulate", PASSING)
    assert decision.accepted
    log, prepare, move = decision.actions
    assert isinstance(log, Log) and log.kind == "checks_at_simulation"
    assert isinstance(prepare, PrepareFlight) and prepare.mode == "simulated"
    assert prepare.payload["simulate_mission"] == {
        "is_enable": 1,
        "latitude": 41.6523,
        "longitude": -4.7245,
    }
    assert prepare.payload["file"] == {
        "url": f"http://soc-cloud:8081/files/{FILE.token}.kmz",
        "fingerprint": FILE.md5,
    }
    assert prepare.payload["rth_altitude"] == 20
    assert move == Move("simulating", "simulate")


@pytest.mark.parametrize(
    ("changes", "checks", "named"),
    [
        ({}, FAILING, "PF-BATTERY: battery 12 % under 30 %"),
        ({"status": status(simulator_mode=False)}, PASSING, "the stack is in real mode"),
        ({"status": status(simulator_mode=None)}, PASSING, "the stack's mode is not known"),
        ({"status": None}, PASSING, "the stack's mode is not known"),
        ({"file": None}, PASSING, "no flight file"),
        ({"flight_files_url": None}, PASSING, "flight file address is not known"),
        ({"state": "planned"}, PASSING, "not preparing"),
    ],
    ids=["check", "real-mode", "mode-null", "no-status", "no-file", "no-url", "not-preparing"],
)
def test_simulate_is_refused_naming_why(
    changes: dict[str, Any], checks: list[Judged], named: str
) -> None:
    """FR-OPS-06 and FR-SAF-04: with a check failing or the mode unknown, nothing is prepared."""
    state = changes.pop("state", "preparing")
    decision = on_request(snapshot(state, **changes), "simulate", checks)
    assert not decision.accepted
    assert any(named in reason for reason in decision.reasons), decision.reasons
    assert not any(isinstance(action, PrepareFlight) for action in decision.actions)


def simulated_ok(**changes: Any) -> Flight:
    return flight(state=FlightState("ok", 0, "completed"), ended=True, **changes)


def test_launch_prepares_the_simulated_file_for_real() -> None:
    ready = snapshot(
        "ready",
        status=status(simulator_mode=False, simulator_active=False),
        flights=(simulated_ok(),),
    )
    decision = on_request(ready, "launch", PASSING)
    assert decision.accepted
    prepare = next(action for action in decision.actions if isinstance(action, PrepareFlight))
    assert prepare.mode == "real"
    assert prepare.payload["simulate_mission"]["is_enable"] == 0
    assert moves(decision) == ["launching"]


def test_launch_is_refused_when_the_phones_configuration_changed_naming_both() -> None:
    """FR-OPS-07's acceptance: another fingerprint than the pass's keeps it from flying."""
    changed = snapshot(
        "ready",
        status=status(simulator_mode=False, simulator_active=False, config_fingerprint="b" * 64),
        flights=(simulated_ok(),),
    )
    decision = on_request(changed, "launch", PASSING)
    assert not decision.accepted
    assert any(FINGERPRINT in reason and "b" * 64 in reason for reason in decision.reasons)


def test_launch_needs_a_simulation_of_this_very_file() -> None:
    other = snapshot(
        "ready",
        status=status(simulator_mode=False, simulator_active=False),
        flights=(simulated_ok(file_id=uuid.uuid4()),),
    )
    decision = on_request(other, "launch", PASSING)
    assert "this file has not completed a simulation" in decision.reasons


def test_stop_sends_every_aircraft_home_and_returns() -> None:
    """FR-CMD-04: every flight of the operation receives return_home."""
    first, second = flight(mode="real"), flight(mode="real")
    decision = on_request(
        snapshot("in_flight", flights=(first, second, simulated_ok())), "stop", []
    )
    assert decision.actions == (
        Command("return_home", first.id, {}),
        Command("return_home", second.id, {}),
        Move("returning", "stop"),
    )
    assert not on_request(snapshot("ready"), "stop", []).accepted


# --- Command outcomes -----------------------------------------------------------------------


def test_a_prepare_accepted_is_executed() -> None:
    current = flight()
    decision = on_outcome(
        snapshot("simulating", flights=(current,)), Outcome("prepare", current.id, "accepted", 0)
    )
    assert decision.actions == (Command("execute", current.id, {"flight_id": str(current.id)}),)


def test_an_execute_accepted_puts_a_launch_in_flight() -> None:
    current = flight(mode="real")
    decision = on_outcome(
        snapshot("launching", flights=(current,)), Outcome("execute", current.id, "accepted", 0)
    )
    assert moves(decision) == ["in_flight"]
    simulating = on_outcome(
        snapshot("simulating", flights=(current,)), Outcome("execute", current.id, "accepted", 0)
    )
    assert moves(simulating) == []
    # From then on the flight flies: soc-cloud watches it (FR-SAF-01).
    assert Executed(current.id) in decision.actions
    assert simulating.actions == (Executed(current.id),)


def test_a_refused_prepare_returns_to_ready_with_its_meaning() -> None:
    """FR-OPS-09's acceptance: a refusal returns to ready with the meaning shown."""
    current = flight(mode="real")
    decision = on_outcome(
        snapshot("launching", flights=(current,)), Outcome("prepare", current.id, "refused", 314010)
    )
    assert decision.actions[0] == EndFlight(current.id, "cancelled")
    move = decision.actions[-1]
    assert isinstance(move, Move) and move.to == "ready"
    assert "has not completed a simulation on this stack" in move.cause


def test_a_refused_execute_is_undone_before_going_back() -> None:
    current = flight(mode="real")
    decision = on_outcome(
        snapshot("launching", flights=(current,)), Outcome("execute", current.id, "refused", 314010)
    )
    assert decision.actions[0] == Command("undo", current.id, {"flight_ids": [str(current.id)]})
    assert "Arm the phone" in decision.reasons[0]


@pytest.mark.parametrize(
    ("said", "words"),
    [
        (
            status(link={"state": "down", "reason": None, "changed_at_ms": 1}),
            "link to the phone is down",
        ),
        (status(simulator_mode=False, simulator_active=True), "Turn the phone's simulator off"),
        (status(simulator_mode=True, simulator_active=False), "Turn the phone's simulator on"),
    ],
    ids=["link-down", "simulator-on-in-real", "simulator-off-in-simulator"],
)
def test_316010_on_an_execute_is_told_apart_by_the_stacks_status(
    said: dict[str, Any], words: str
) -> None:
    current = flight(mode="real")
    decision = on_outcome(
        snapshot("launching", flights=(current,), status=said),
        Outcome("execute", current.id, "refused", 316010),
    )
    assert words in decision.reasons[0]


def test_an_execute_with_an_unknown_outcome_waits_for_the_progress() -> None:
    """DEP-27: 319999 is not a refusal; the flight's progress settles it."""
    current = flight(mode="real")
    decision = on_outcome(
        snapshot("launching", flights=(current,)), Outcome("execute", current.id, "refused", 319999)
    )
    assert moves(decision) == []
    assert not any(isinstance(action, EndFlight) for action in decision.actions)


def test_a_simulation_refused_goes_back_to_preparing() -> None:
    current = flight()
    decision = on_outcome(
        snapshot("simulating", flights=(current,)),
        Outcome("prepare", current.id, "timed_out", None),
    )
    assert moves(decision) == ["preparing"]


def test_an_outcome_for_an_ended_flight_or_a_settled_operation_changes_nothing() -> None:
    ended = flight(ended=True)
    assert (
        on_outcome(
            snapshot("simulating", flights=(ended,)), Outcome("prepare", ended.id, "accepted", 0)
        ).actions
        == ()
    )
    current = flight()
    assert (
        on_outcome(
            snapshot("ready", flights=(current,)), Outcome("prepare", current.id, "accepted", 0)
        ).actions
        == ()
    )


# --- Progress -----------------------------------------------------------------------------


def test_a_simulation_ended_ok_makes_the_operation_simulated() -> None:
    current = flight(state=FlightState("ok", 0, "completed"))
    decision = on_progress(snapshot("simulating", flights=(current,)), current.id)
    assert decision.actions == (
        EndFlight(current.id, "completed"),
        Move("simulated", "simulation ok"),
    )


def test_a_simulation_that_failed_goes_back_to_preparing_with_its_reason() -> None:
    """FR-OPS-06's acceptance: an aborted pass returns to preparing with its end reason."""
    current = flight(state=FlightState("failed", 321773, "low_battery"))
    decision = on_progress(snapshot("simulating", flights=(current,)), current.id)
    assert moves(decision) == ["preparing"]
    assert EndFlight(current.id, "low_battery") in decision.actions


def test_a_real_flight_moves_the_operation_in_flight_paused_and_back() -> None:
    running = flight(mode="real", state=FlightState("in_progress", None, None), took_off=True)
    assert moves(on_progress(snapshot("launching", flights=(running,)), running.id)) == [
        "in_flight"
    ]
    paused = dataclasses.replace(running, state=FlightState("paused", None, None))
    assert moves(on_progress(snapshot("in_flight", flights=(paused,)), paused.id)) == ["paused"]
    assert moves(on_progress(snapshot("paused", flights=(running,)), running.id)) == ["in_flight"]


def test_an_ended_task_returns_and_the_operation_closes_on_the_ground() -> None:
    """FR-OPS-10: returning until the aircraft stands on the ground, then closed."""
    airborne = flight(mode="real", took_off=True, state=FlightState("ok", 0, "completed"))
    assert moves(on_progress(snapshot("in_flight", flights=(airborne,)), airborne.id)) == [
        "returning"
    ]
    landed = dataclasses.replace(airborne, landed=True)
    decision = on_progress(snapshot("returning", flights=(landed,)), landed.id)
    assert decision.actions[0] == EndFlight(landed.id, "completed")
    assert decision.actions[1] == Move(
        "completed", "on the ground after the flight ended ok", "completed"
    )


@pytest.mark.parametrize(
    ("reason", "closing"),
    [
        ("operator_return", "aborted"),
        ("geofence_breach", "aborted"),
        ("low_battery", "failed"),
        ("link_lost", "failed"),
        ("pilot_takeover", "failed"),
        ("envelope_breach", "failed"),
        ("aircraft_fault", "failed"),
    ],
)
def test_the_operation_closes_by_how_its_flight_ended(reason: str, closing: str) -> None:
    landed = flight(mode="real", took_off=True, landed=True, state=FlightState("failed", 1, reason))
    assert moves(on_progress(snapshot("returning", flights=(landed,)), landed.id)) == [closing]


def test_a_stop_closes_aborted_with_the_operators_stop() -> None:
    """FR-CMD-04: the operation ends aborted once they have landed."""
    landed = flight(
        mode="real",
        took_off=True,
        landed=True,
        state=FlightState("canceled", 322283, "operator_return"),
    )
    decision = on_progress(snapshot("returning", flights=(landed,), stopped=True), landed.id)
    assert decision.actions[-1] == Move(
        "aborted", "on the ground after the flight ended canceled", "operator_stop"
    )


def test_a_task_ended_before_take_off_closes_at_once() -> None:
    never = flight(mode="real", state=FlightState("canceled", 0, "cancelled"))
    assert moves(on_progress(snapshot("launching", flights=(never,)), never.id)) == [
        "returning",
        "aborted",
    ]


# --- Readiness ----------------------------------------------------------------------------


REAL = status(simulator_mode=False, simulator_active=False)


def test_a_simulated_operation_is_ready_while_every_condition_holds() -> None:
    simulated = snapshot("simulated", status=REAL, flights=(simulated_ok(),))
    assert moves(on_checks(simulated, PASSING)) == ["ready"]
    assert moves(on_checks(dataclasses.replace(simulated, state="ready"), FAILING)) == ["simulated"]
    assert moves(on_checks(dataclasses.replace(simulated, state="ready"), PASSING)) == []


def test_ready_waits_for_real_mode_and_the_same_fingerprint() -> None:
    in_simulator = snapshot("simulated", flights=(simulated_ok(),))
    assert moves(on_checks(in_simulator, PASSING)) == []
    changed = snapshot(
        "simulated", status={**REAL, "config_fingerprint": "c" * 64}, flights=(simulated_ok(),)
    )
    assert moves(on_checks(changed, PASSING)) == []
