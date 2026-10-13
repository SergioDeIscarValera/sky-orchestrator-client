"""What soc-operations does with an operation, decided from a snapshot of it (FR-OPS, FR-CMD).

Every decision is a pure function: a snapshot of the operation in, a list of actions out,
which the store applies in one transaction (soc_operations.store). Nothing here reads the
database, the wire or the clock, so the whole lifecycle is tested without them.

- A member's transition request (IR-TRQ) is accepted with its actions, or refused with
  every reason named (FR-OPS-03, FR-OPS-09).
- A command's outcome moves the flight it was for: a prepare accepted is executed, a
  refusal sends the operation back with Sky Orchestrator's meaning (FR-OPS-06, FR-OPS-09).
- A flight's progress moves the operation: simulated when its simulation ends ok, in
  flight, paused, returning, and closed once the aircraft has landed (FR-OPS-10).
- The checks, judged continuously, move a simulated operation to ready and back
  (FR-OPS-07).
- An execute whose outcome Sky Orchestrator could not learn waits for the flight's
  progress; with none `OUTCOME_SETTLES_WITHIN_S` after, the flight never started, and the
  operation goes back as after a refusal (DEP-27).

The moves are the lifecycle's own (contracts/operations/lifecycle.json); the database
refuses any other.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from soc_operations.results import meaning
from soc_operations.validation import OperationView, envelope_of, plan_problems

#: DJI's prepare: an immediate waypoint task (Sky Orchestrator implements only those).
IMMEDIATE, WAYPOINT_TASK = 0, 0
#: Go home when the aircraft is out of control, and leave link loss to the device's own
#: policy (FR-SAF-06), as Sky Orchestrator's reference flight does (its infra/fly.py).
GO_HOME, KEEP_WAYLINE_ON_RC_LOSS = 0, 0
#: DJI's lowest return-to-home altitude.
LEAST_RTH_ALTITUDE_M = 20
#: The result of an execute whose outcome Sky Orchestrator could not learn (DEP-27).
OUTCOME_UNKNOWN = 319999
#: An execute carries a deadline 3 s ahead on the phone's clock, refused past it (DEP-27):
#: a flight whose execute's outcome is unknown and that has reported no progress this long
#: after the reply never started.
OUTCOME_SETTLES_WITHIN_S = 10.0


class Check(Protocol):
    """A judged preflight check (soc_operations.checks)."""

    @property
    def check_id(self) -> str: ...
    @property
    def state(self) -> str: ...
    @property
    def blocking(self) -> bool: ...
    @property
    def detail(self) -> str: ...


# --- What a decision reads -------------------------------------------------------------


@dataclass(frozen=True)
class FlightState:
    """A flight's latest progress, as soc-cloud recorded it (IR-FST)."""

    status: str
    result: int | None
    end_reason: str | None


@dataclass(frozen=True)
class Flight:
    id: uuid.UUID
    mode: str
    file_id: uuid.UUID
    config_fingerprint: str | None
    executed: bool
    took_off: bool
    landed: bool
    ended: bool
    state: FlightState | None
    #: When an execute of it was answered with an unknown outcome (DEP-27), if one was.
    outcome_unknown_since: datetime | None = None


@dataclass(frozen=True)
class File:
    id: uuid.UUID
    md5: str
    token: str


@dataclass(frozen=True)
class Snapshot:
    """One operation as soc-operations decides on it."""

    operation_id: uuid.UUID
    state: str
    view: OperationView
    #: What the fleet's stack last said: its status and envelope (None when unknown).
    status: Mapping[str, Any] | None
    envelope: Mapping[str, Any] | None
    flight_files_url: str | None
    #: The file built at the last prepare, if any.
    file: File | None
    #: The operation's flights, the newest first.
    flights: Sequence[Flight]
    #: Whether a pilot's stop of this operation was accepted (FR-CMD-04).
    stopped: bool

    @property
    def current(self) -> Flight | None:
        """The newest flight not ended, if there is one."""
        return next((each for each in self.flights if not each.ended), None)

    def simulation(self) -> Flight | None:
        """The newest simulated flight of the current file that ended ok (ADR-0011)."""
        for each in self.flights:
            if (
                each.mode == "simulated"
                and self.file is not None
                and each.file_id == self.file.id
                and each.state is not None
                and each.state.status == "ok"
            ):
                return each
        return None


# --- What a decision does --------------------------------------------------------------


@dataclass(frozen=True)
class Move:
    to: str
    cause: str
    end_reason: str | None = None


@dataclass(frozen=True)
class BuildFile:
    """Build the flight file from the assignment's flight and ask the stack's dry run."""


@dataclass(frozen=True)
class PrepareFlight:
    """A new flight of the current file, and the prepare that asks Sky Orchestrator for it."""

    mode: str
    payload: Mapping[str, Any]


@dataclass(frozen=True)
class Command:
    verb: str
    flight_id: uuid.UUID
    payload: Mapping[str, Any]


@dataclass(frozen=True)
class Executed:
    """Sky Orchestrator accepted the flight's execute: it flies from now, and soc-cloud watches."""

    flight_id: uuid.UUID


@dataclass(frozen=True)
class EndFlight:
    flight_id: uuid.UUID
    end_reason: str


@dataclass(frozen=True)
class Log:
    kind: str
    payload: Mapping[str, Any]


type Action = Move | BuildFile | PrepareFlight | Command | Executed | EndFlight | Log


@dataclass(frozen=True)
class Decision:
    """Accepted with its actions, or refused with every reason; actions may follow either."""

    accepted: bool
    reasons: tuple[str, ...] = ()
    actions: tuple[Action, ...] = field(default=())


def refused(*reasons: str) -> Decision:
    return Decision(False, reasons)


def accepted(*actions: Action) -> Decision:
    return Decision(True, (), actions)


# --- Transition requests (IR-TRQ) --------------------------------------------------------


def on_request(snapshot: Snapshot, transition: str, checks: Sequence[Check]) -> Decision:
    """A member asks the operation to move: accept it with what it takes, or say why not."""
    state = snapshot.state
    match transition:
        case "plan":
            if state != "draft":
                return refused(f"the operation is {state}, not a draft")
            return _planned(snapshot, Move("planned", "plan"))
        case "prepare":
            if state != "planned":
                return refused(f"the operation is {state}, not planned")
            return _planned(snapshot, BuildFile(), Move("preparing", "prepare"))
        case "unprepare":
            if state != "preparing":
                return refused(f"the operation is {state}, not preparing")
            return accepted(Move("planned", "unprepare"))
        case "cancel":
            if state not in {"draft", "planned", "preparing", "simulated", "ready"}:
                return refused(f"an operation {state} cannot be cancelled")
            return accepted(Move("cancelled", "cancel"))
        case "simulate":
            return _simulate(snapshot, checks)
        case "launch":
            return _launch(snapshot, checks)
        case "stop":
            return _stop(snapshot)
        case _:
            return refused(f"no transition {transition}")


def _planned(snapshot: Snapshot, *actions: Action) -> Decision:
    problems = plan_problems(snapshot.view, envelope_of(snapshot.envelope))
    if problems:
        return refused(*problems)
    return accepted(*actions)


def _blocking(checks: Sequence[Check]) -> list[str]:
    return [
        f"{check.check_id}: {check.detail}"
        for check in checks
        if check.blocking and check.state != "pass"
    ]


def _simulate(snapshot: Snapshot, checks: Sequence[Check]) -> Decision:
    """FR-OPS-06: every blocking check passing, the stack in simulator mode."""
    if snapshot.state != "preparing":
        return refused(f"the operation is {snapshot.state}, not preparing")
    reasons = _blocking(checks)
    mode = None if snapshot.status is None else snapshot.status.get("simulator_mode")
    if mode is not True:
        reasons.append(
            "the stack is in real mode: a simulation needs simulator mode"
            if mode is False
            else "the stack's mode is not known"
        )
    prepare = _prepare_payload(snapshot, simulated=True)
    if isinstance(prepare, str):
        reasons.append(prepare)
    if reasons:
        return refused(*reasons)
    assert not isinstance(prepare, str)
    return accepted(
        Log("checks_at_simulation", {"checks": _checks(checks)}),
        PrepareFlight("simulated", prepare),
        Move("simulating", "simulate"),
    )


def ready_problems(snapshot: Snapshot, checks: Sequence[Check]) -> list[str]:
    """FR-OPS-07: what keeps a simulated operation from being ready, each named."""
    problems = _blocking(checks)
    simulation = snapshot.simulation()
    if simulation is None:
        problems.append("this file has not completed a simulation")
    status = snapshot.status
    if status is None or status.get("simulator_mode") is not False:
        problems.append("the stack is not in real mode")
    fingerprint = None if status is None else status.get("config_fingerprint")
    if simulation is not None and fingerprint != simulation.config_fingerprint:
        problems.append(
            "the phone's configuration changed since the simulation: simulate again"
            f" (simulated under {simulation.config_fingerprint}, now {fingerprint})"
        )
    return problems


def _launch(snapshot: Snapshot, checks: Sequence[Check]) -> Decision:
    """FR-OPS-09: from ready, confirmed by a pilot, the same file prepared for real."""
    if snapshot.state != "ready":
        return refused(f"the operation is {snapshot.state}, not ready")
    reasons = ready_problems(snapshot, checks)
    prepare = _prepare_payload(snapshot, simulated=False)
    if isinstance(prepare, str):
        reasons.append(prepare)
    if reasons:
        return refused(*reasons)
    assert not isinstance(prepare, str)
    return accepted(
        Log("checks_at_launch", {"checks": _checks(checks)}),
        PrepareFlight("real", prepare),
        Move("launching", "launch"),
    )


def _stop(snapshot: Snapshot) -> Decision:
    """FR-CMD-04: every aircraft of the operation home; the operation ends aborted on landing."""
    if snapshot.state not in {"in_flight", "paused"}:
        return refused(f"the operation is {snapshot.state}: only one in flight stops")
    flying = [each for each in snapshot.flights if not each.ended]
    return accepted(
        *(Command("return_home", each.id, {}) for each in flying),
        Move("returning", "stop"),
    )


def _prepare_payload(snapshot: Snapshot, *, simulated: bool) -> Mapping[str, Any] | str:
    """DJI's prepare for the current file, or why it cannot be asked (FR-SAF-04)."""
    if snapshot.file is None:
        return "the operation has no flight file: prepare it again"
    if snapshot.flight_files_url is None:
        return "the stack's flight file address is not known"
    height = snapshot.view.takeoff_security_height_m
    assignment = snapshot.view.assignments[0] if snapshot.view.assignments else None
    if height is None or assignment is None:
        return "the operation has no height or no assignment"
    takeoff = assignment.wayline.takeoff
    # The flight's id is the store's to give, when it creates the flight.
    return {
        "task_type": IMMEDIATE,
        "wayline_type": WAYPOINT_TASK,
        "file": {
            "url": f"{snapshot.flight_files_url.rstrip('/')}/files/{snapshot.file.token}.kmz",
            "fingerprint": snapshot.file.md5,
        },
        "rth_altitude": max(LEAST_RTH_ALTITUDE_M, math.ceil(height)),
        "out_of_control_action": GO_HOME,
        "exit_wayline_when_rc_lost": KEEP_WAYLINE_ON_RC_LOSS,
        # Sky Orchestrator requires all three and applies only the switch, which must
        # agree with the stack's mode (DEP-02, ADR-0011).
        "simulate_mission": {
            "is_enable": 1 if simulated else 0,
            "latitude": takeoff[1],
            "longitude": takeoff[0],
        },
    }


def _checks(checks: Sequence[Check]) -> list[dict[str, Any]]:
    return [
        {"check_id": c.check_id, "state": c.state, "blocking": c.blocking, "detail": c.detail}
        for c in checks
    ]


# --- Command outcomes (FR-OPS-06, FR-OPS-09, FR-LNK-06) ----------------------------------


@dataclass(frozen=True)
class Outcome:
    """A command intent that has settled."""

    verb: str
    flight_id: uuid.UUID
    status: str
    result: int | None


def on_outcome(snapshot: Snapshot, outcome: Outcome) -> Decision:
    """Execute what was prepared; on a refusal, send the operation back with its meaning."""
    flight = next((each for each in snapshot.flights if each.id == outcome.flight_id), None)
    if flight is None or flight.ended or snapshot.state not in {"simulating", "launching"}:
        return accepted()
    if outcome.verb not in {"prepare", "execute"}:
        return accepted()
    if outcome.status == "accepted":
        if outcome.verb == "prepare":
            return accepted(Command("execute", flight.id, {"flight_id": str(flight.id)}))
        if snapshot.state == "launching":
            return accepted(Executed(flight.id), Move("in_flight", "executing"))
        return accepted(Executed(flight.id))
    if outcome.verb == "execute" and outcome.result == OUTCOME_UNKNOWN:
        # Sky Orchestrator gave up on the phone, which may have started: the progress
        # settles it, or its absence does (on_tick, DEP-27). The database logged the outcome.
        return accepted()
    told = _told(outcome, snapshot)
    back = "preparing" if snapshot.state == "simulating" else "ready"
    actions: list[Action] = [EndFlight(flight.id, "cancelled")]
    if outcome.verb == "execute":
        # A task left prepared would hold the stack: undo it (FR-CMD-05).
        actions.insert(0, Command("undo", flight.id, {"flight_ids": [str(flight.id)]}))
    actions.append(Move(back, f"{outcome.verb} {outcome.status}: {told['meaning']}"))
    return Decision(True, (str(told["meaning"]),), tuple(actions))


def on_tick(snapshot: Snapshot, now: datetime) -> Decision:
    """A flight whose execute's outcome stayed unknown, with no progress since: it never
    started, so it is undone and ended cancelled, and the operation goes back (DEP-27)."""
    if snapshot.state not in {"simulating", "launching"}:
        return accepted()
    for flight in snapshot.flights:
        since = flight.outcome_unknown_since
        if flight.ended or flight.state is not None or since is None:
            continue
        if (now - since).total_seconds() < OUTCOME_SETTLES_WITHIN_S:
            continue
        why = "the execute's outcome stayed unknown and the flight reported no progress"
        back = "preparing" if snapshot.state == "simulating" else "ready"
        return Decision(
            True,
            (why,),
            (
                Command("undo", flight.id, {"flight_ids": [str(flight.id)]}),
                EndFlight(flight.id, "cancelled"),
                Move(back, f"execute unknown: {why}"),
            ),
        )
    return accepted()


def _told(outcome: Outcome, snapshot: Snapshot) -> dict[str, Any]:
    if outcome.status != "refused" or outcome.result is None:
        said = f"the {outcome.verb} {outcome.status.replace('_', ' ')}"
        return {"verb": outcome.verb, "status": outcome.status, "meaning": said}
    return {
        "verb": outcome.verb,
        "status": outcome.status,
        "result": outcome.result,
        "meaning": meaning(outcome.verb, outcome.result, snapshot.status),
    }


# --- Flight progress (FR-LNK-07, FR-OPS-06, FR-OPS-10) -----------------------------------

TERMINAL = frozenset({"ok", "failed", "canceled", "rejected", "timeout", "partially_done"})
#: How an operation closes, by how its flight ended (contracts/operations/lifecycle.json).
CLOSING = {
    "completed": "completed",
    "operator_stop": "aborted",
    "operator_return": "aborted",
    "geofence_breach": "aborted",
    "cancelled": "aborted",
}


def on_progress(snapshot: Snapshot, flight_id: uuid.UUID) -> Decision:
    """Move the operation on what its flight reports."""
    flight = next((each for each in snapshot.flights if each.id == flight_id), None)
    if flight is None or flight.state is None:
        return accepted()
    status, state = flight.state.status, snapshot.state
    if flight.mode == "simulated":
        if state != "simulating" or status not in TERMINAL or flight.ended:
            return accepted()
        if status == "ok":
            return accepted(EndFlight(flight.id, "completed"), Move("simulated", "simulation ok"))
        reason = flight.state.end_reason or "aircraft_fault"
        return accepted(
            EndFlight(flight.id, reason),
            Move("preparing", f"simulation {status}: {reason}"),
        )
    if status == "paused" and state == "in_flight":
        return accepted(Move("paused", "flight paused"))
    if status == "in_progress" and state in {"launching", "paused"}:
        return accepted(Move("in_flight", "flight in progress"))
    if status not in TERMINAL or flight.ended:
        return accepted()
    actions: list[Action] = []
    if state in {"launching", "in_flight", "paused"}:
        actions.append(Move("returning", f"flight {status}"))
    elif state != "returning":
        return accepted()
    # Closed once the aircraft stands on the ground: landed, or it never took off.
    if _on_ground(flight):
        reason = _end_reason(snapshot, flight)
        actions += [
            EndFlight(flight.id, reason),
            Move(
                CLOSING.get(reason, "failed"),
                f"on the ground after the flight ended {status}",
                reason,
            ),
        ]
    return accepted(*actions)


def _end_reason(snapshot: Snapshot, flight: Flight) -> str:
    """A pilot's stop first; else how soc-cloud read the task's end; else by its status."""
    if snapshot.stopped:
        return "operator_stop"
    assert flight.state is not None
    if flight.state.end_reason is not None:
        return flight.state.end_reason
    return "completed" if flight.state.status == "ok" else "aircraft_fault"


def _on_ground(flight: Flight) -> bool:
    """Landed after it took off, or never took off at all (FR-OPS-10)."""
    return flight.landed or not flight.took_off


# --- Readiness (FR-OPS-07) --------------------------------------------------------------


def on_checks(snapshot: Snapshot, checks: Sequence[Check]) -> Decision:
    """A simulated operation becomes ready while every condition holds, and stops being so."""
    problems = ready_problems(snapshot, checks)
    if snapshot.state == "simulated" and not problems:
        return accepted(Move("ready", "every condition of ready holds"))
    if snapshot.state == "ready" and problems:
        return accepted(Move("simulated", problems[0]))
    return accepted()
