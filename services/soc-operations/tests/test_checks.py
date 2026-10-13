"""The preflight checks (FR-OPS-04, FR-OPS-05, FR-OPS-08, FR-SAF-02..04), as pure functions.

One valid baseline passes all sixteen checks. Each check then has a case that fails it and one
that leaves it unknown, each made by changing one input of the baseline, and a case that passes
it is the baseline itself. The safety rules have their own tests: a frozen feed never passes,
a status read long ago never passes a mode, arming, simulator or clock check, an envelope one
metre outside fails naming its vertex, and PF-CLOCK never blocks.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import msgspec
import pytest

import soc_config
from soc_geo.projection import Geodetic
from soc_geo.sphere import EARTH_RADIUS_M, distance_m
from soc_operations.checks import (
    AircraftView,
    Check,
    DryRun,
    Inputs,
    StackView,
    blocking_pass,
    judge,
)
from soc_operations.settings import SERVICE, Tunables

ORDER = (
    "PF-LINK",
    "PF-ONLINE",
    "PF-FRESH",
    "PF-GNSS",
    "PF-BATTERY",
    "PF-GROUNDED",
    "PF-INSIDE",
    "PF-TAKEOFF",
    "PF-WAYLINE",
    "PF-SO-DRYRUN",
    "PF-ENVELOPE",
    "PF-MODE",
    "PF-SIMULATOR",
    "PF-ARMED",
    "PF-IDLE",
    "PF-CLOCK",
)
SAMPLE_DEPENDENT = ("PF-FRESH", "PF-GNSS", "PF-BATTERY", "PF-GROUNDED", "PF-INSIDE", "PF-TAKEOFF")
STATUS_DEPENDENT = ("PF-LINK", "PF-MODE", "PF-SIMULATOR", "PF-ARMED", "PF-CLOCK")

NOW = datetime(2026, 10, 13, 10, 0, 0, tzinfo=UTC)
FARM = (41.6523, -4.7245)  # latitude, longitude: the farm
CENTRE = Geodetic(latitude_deg=FARM[0], longitude_deg=FARM[1])
STALE_AFTER_MS = 3000  # telemetry_stale_after_ms in the contract's defaults

CONTRACT = soc_config.Contract.read()
TUNABLES = msgspec.convert(
    {**CONTRACT.starting_file(SERVICE), "served_organizations": []}, Tunables, strict=True
)


def _ms(instant: datetime) -> int:
    return int(instant.timestamp() * 1000)


def status_dict() -> dict[str, Any]:
    """A StackStatus (openapi.yaml) as the stack reports it: the phone in simulator, armed."""
    return {
        "schema_version": "1.3.0",
        "at_ms": _ms(NOW),
        "simulator_mode": True,
        "link": {"state": "up", "reason": None, "changed_at_ms": _ms(NOW) - 60_000},
        "simulator_active": True,
        "aircraft_connected": True,
        "aircraft_online": True,
        "aircraft_reason": None,
        "armed": True,
        "arming_remaining_s": 300,
        "clock_offset_ms": -120,
        "clock_offset_uncertainty_ms": 18,
        "contract_version": "1.9.0",
        "config_fingerprint": "f" * 64,
        "warnings": [],
    }


def envelope_dict() -> dict[str, Any]:
    """An Envelope (openapi.yaml): the phone's circle is the farm's, 2 km, and 120 m high."""
    return {
        "envelope": {
            "geofence_center": {"latitude_deg": FARM[0], "longitude_deg": FARM[1]},
            "geofence_radius_m": 2000.0,
            "max_height_m": 120.0,
            "max_home_distance_m": 2000.0,
            "max_leg_m": 1000.0,
            "max_transit_m": 2000.0,
            "max_total_distance_m": 20000.0,
            "max_waypoints": 200,
            "max_horizontal_speed_ms": 15.0,
        },
        "envelope_fingerprint": "a" * 64,
        "config_fingerprint": "b" * 64,
        "application_in_force": None,
    }


def sample_dict() -> dict[str, Any]:
    """A broadcast telemetry sample (contracts/broadcast/telemetry.schema.json), on the ground."""
    return {
        "stack": "farm",
        "gateway_sn": "GW1A2B3C",
        "aircraft_sn": "AC1A2B3C",
        "taken_at_ms": _ms(NOW),
        "sent_at_ms": _ms(NOW),
        "latitude_deg": FARM[0],
        "longitude_deg": FARM[1],
        "height_m": 0.0,
        "heading_deg": 90.0,
        "home_distance_m": 0.0,
        "battery_pct": 90,
        "satellites": 16,
        "gps_quality": 5,
        "mode_code": 0,
    }


def verdict_valid() -> dict[str, Any]:
    return {
        "status": "VALID",
        "fingerprint_md5": "0" * 32,
        "size_bytes": 1024,
        "config_fingerprint": "b" * 64,
        "metadata": {},
        "report": {"status": "VALID", "checks": [], "problems": []},
    }


def verdict_rejected() -> dict[str, Any]:
    problem = {
        "code": "outside_geofence",
        "kind": "envelope",
        "message": "waypoint 3 is 2400.0 m from the geofence centre; the radius is 2000.0 m",
        "waypoint_index": 3,
    }
    return {
        "status": "REJECTED",
        "fingerprint_md5": "0" * 32,
        "size_bytes": 1024,
        "config_fingerprint": "b" * 64,
        "metadata": {},
        "report": {"status": "REJECTED", "checks": [], "problems": [problem]},
    }


# A square of about 330 m by 280 m around the farm, [longitude, latitude] and not closed.
RING: list[list[float]] = [
    [FARM[1] - 0.003, FARM[0] - 0.003],
    [FARM[1] + 0.003, FARM[0] - 0.003],
    [FARM[1] + 0.003, FARM[0] + 0.003],
    [FARM[1] - 0.003, FARM[0] + 0.003],
]


def baseline() -> Inputs:
    """Inputs that pass all sixteen checks: the phone in simulator and armed, on the ground."""
    fresh = NOW - timedelta(seconds=1)
    return Inputs(
        now=NOW,
        stack=StackView(
            link_state="connected",
            status=status_dict(),
            status_read_at=fresh,
            envelope=envelope_dict(),
            envelope_read_at=fresh,
        ),
        aircraft=AircraftView(
            online=True,
            sample=sample_dict(),
            received_at=NOW - timedelta(milliseconds=500),
        ),
        geofence_ring=RING,
        geofence_max_height_m=100.0,
        takeoff=[FARM[1], FARM[0]],
        wayline_problems=[],
        dry_run=DryRun(status="valid", verdict=verdict_valid()),
        stack_busy=False,
        tunables=TUNABLES,
    )


type Change = Callable[[Inputs], Inputs]


def _stack(inputs: Inputs) -> StackView:
    assert inputs.stack is not None
    return inputs.stack


def _aircraft(inputs: Inputs) -> AircraftView:
    assert inputs.aircraft is not None
    return inputs.aircraft


def inputs_with(**changes: Any) -> Change:
    return lambda inputs: replace(inputs, **changes)


def stack_with(**changes: Any) -> Change:
    return lambda inputs: replace(inputs, stack=replace(_stack(inputs), **changes))


def status_with(**changes: Any) -> Change:
    def change(inputs: Inputs) -> Inputs:
        stack = _stack(inputs)
        assert stack.status is not None
        status = {**stack.status, **changes}
        return replace(inputs, stack=replace(stack, status=status))

    return change


def envelope_with(**changes: Any) -> Change:
    def change(inputs: Inputs) -> Inputs:
        stack = _stack(inputs)
        assert stack.envelope is not None
        return replace(inputs, stack=replace(stack, envelope={**stack.envelope, **changes}))

    return change


def sample_with(**changes: Any) -> Change:
    def change(inputs: Inputs) -> Inputs:
        aircraft = _aircraft(inputs)
        assert aircraft.sample is not None
        sample = {**aircraft.sample, **changes}
        return replace(inputs, aircraft=replace(aircraft, sample=sample))

    return change


def aircraft_with(**changes: Any) -> Change:
    return lambda inputs: replace(inputs, aircraft=replace(_aircraft(inputs), **changes))


def destination(bearing_deg: float, metres: float, origin: Geodetic = CENTRE) -> list[float]:
    """The [longitude, latitude] `metres` from `origin` on `bearing_deg`, on SOC's sphere.

    The inverse of soc_geo.sphere.distance_m, so the distance the checks measure is `metres`.
    """
    lat1 = math.radians(origin.latitude_deg)
    lon1 = math.radians(origin.longitude_deg)
    bearing = math.radians(bearing_deg)
    angular = metres / EARTH_RADIUS_M
    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular) + math.cos(lat1) * math.sin(angular) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angular) * math.cos(lat1),
        math.cos(angular) - math.sin(lat1) * math.sin(lat2),
    )
    return [math.degrees(lon2), math.degrees(lat2)]


def by_id(checks_: tuple[Check, ...]) -> dict[str, Check]:
    return {check.check_id: check for check in checks_}


def judged(inputs: Inputs) -> dict[str, Check]:
    return by_id(judge(inputs))


# A convex pentagon around the farm; its third vertex (index 2) lies 1 m beyond the envelope's
# 2000 m circle, and the rest inside it, so the polygon is simple and only the envelope fails.
ONE_METRE_OUTSIDE: list[list[float]] = [
    destination(225.0, 707.1),
    destination(135.0, 707.1),
    destination(90.0, 2001.0),
    destination(45.0, 707.1),
    destination(315.0, 707.1),
]


# ---------------------------------------------------------------- the baseline


def test_the_thresholds_are_the_contract_defaults() -> None:
    assert TUNABLES.telemetry_stale_after_ms == STALE_AFTER_MS
    assert TUNABLES.min_satellites == 12
    assert TUNABLES.min_gps_quality == 4
    assert TUNABLES.min_battery_start_pct == 50
    assert TUNABLES.takeoff_tolerance_m == 10.0
    assert TUNABLES.min_arming_left_s == 120


def test_the_checks_come_in_the_order_of_the_table() -> None:
    assert tuple(check.check_id for check in judge(baseline())) == ORDER


def test_the_baseline_passes_every_check() -> None:
    checks_ = judge(baseline())
    assert [check.state for check in checks_] == ["pass"] * 16
    assert blocking_pass(checks_)


@pytest.mark.parametrize("check_id", ORDER)
def test_each_check_passes_on_the_baseline(check_id: str) -> None:
    assert judged(baseline())[check_id].state == "pass"


def test_only_pf_clock_is_not_blocking() -> None:
    checks_ = judge(baseline())
    assert [check.check_id for check in checks_ if not check.blocking] == ["PF-CLOCK"]


def test_judging_twice_gives_the_same_checks() -> None:
    assert judge(baseline()) == judge(baseline())


@pytest.mark.parametrize("check_id", ORDER)
def test_every_check_carries_a_detail_sentence(check_id: str) -> None:
    detail = judged(baseline())[check_id].detail
    assert detail.endswith(".") and detail[0].isupper()


# ---------------------------------------------------------------- pass, fail and unknown, per check

FAIL, UNKNOWN = "fail", "unknown"

CASES = [
    # PF-LINK: the link to the stack is connected and up on its status.
    pytest.param("PF-LINK", FAIL, stack_with(link_state="displaced"), id="link-displaced"),
    pytest.param(
        "PF-LINK",
        FAIL,
        status_with(link={"state": "down", "reason": "heartbeat_timeout", "changed_at_ms": 1}),
        id="status-link-down",
    ),
    pytest.param("PF-LINK", UNKNOWN, stack_with(status=None), id="link-status-not-read"),
    # PF-ONLINE: the aircraft is online over a connected link.
    pytest.param("PF-ONLINE", FAIL, aircraft_with(online=False), id="offline"),
    pytest.param("PF-ONLINE", UNKNOWN, aircraft_with(online=None), id="presence-unknown"),
    # PF-FRESH: the latest sample is current; a stale one fails it, a missing one is unknown.
    pytest.param(
        "PF-FRESH",
        FAIL,
        aircraft_with(received_at=NOW - timedelta(seconds=4)),
        id="sample-four-seconds-old",
    ),
    pytest.param("PF-FRESH", UNKNOWN, aircraft_with(sample=None), id="no-sample"),
    # PF-GNSS: satellites and positioning quality reach their minimums.
    pytest.param("PF-GNSS", FAIL, sample_with(satellites=11), id="satellites-under-minimum"),
    pytest.param("PF-GNSS", FAIL, sample_with(gps_quality=3), id="quality-under-minimum"),
    pytest.param("PF-GNSS", UNKNOWN, sample_with(satellites=None), id="satellites-null"),
    # PF-BATTERY: the battery reaches min_battery_start_pct.
    pytest.param("PF-BATTERY", FAIL, sample_with(battery_pct=49), id="battery-under-minimum"),
    pytest.param("PF-BATTERY", UNKNOWN, sample_with(battery_pct=None), id="battery-null"),
    # PF-GROUNDED: the flight mode is idle, preparing or ready to take off.
    pytest.param("PF-GROUNDED", FAIL, sample_with(mode_code=5), id="mode-wayline"),
    pytest.param("PF-GROUNDED", UNKNOWN, sample_with(mode_code=None), id="flight-mode-null"),
    # PF-INSIDE: the aircraft is inside the geofence, ceiling included.
    pytest.param(
        "PF-INSIDE", FAIL, sample_with(latitude_deg=FARM[0] + 0.01), id="north-of-the-polygon"
    ),
    pytest.param("PF-INSIDE", FAIL, sample_with(height_m=150.0), id="above-the-ceiling"),
    pytest.param("PF-INSIDE", UNKNOWN, sample_with(latitude_deg=None), id="position-null"),
    pytest.param("PF-INSIDE", UNKNOWN, sample_with(latitude_deg=95.0), id="position-out-of-range"),
    # PF-TAKEOFF: the aircraft is within takeoff_tolerance_m of the takeoff point.
    pytest.param(
        "PF-TAKEOFF",
        FAIL,
        sample_with(latitude_deg=FARM[0] + 0.0025),
        id="278-metres-from-takeoff",
    ),
    pytest.param("PF-TAKEOFF", UNKNOWN, inputs_with(takeoff=None), id="takeoff-unknown"),
    pytest.param("PF-TAKEOFF", UNKNOWN, sample_with(latitude_deg=95.0), id="position-out-of-range"),
    pytest.param(
        "PF-TAKEOFF", FAIL, inputs_with(takeoff=[FARM[1], 95.0]), id="takeoff-not-a-position"
    ),
    # PF-WAYLINE: SOC's own validation of the wayline.
    pytest.param(
        "PF-WAYLINE",
        FAIL,
        inputs_with(wayline_problems=["waypoint 3 leaves the geofence"]),
        id="problem-named",
    ),
    pytest.param("PF-WAYLINE", UNKNOWN, inputs_with(wayline_problems=None), id="not-judged"),
    # PF-SO-DRYRUN: Sky Orchestrator's dry run accepts the flight file.
    pytest.param(
        "PF-SO-DRYRUN",
        FAIL,
        inputs_with(dry_run=DryRun(status="rejected", verdict=verdict_rejected())),
        id="rejected",
    ),
    pytest.param(
        "PF-SO-DRYRUN",
        UNKNOWN,
        inputs_with(dry_run=DryRun(status="pending", verdict=None)),
        id="pending",
    ),
    pytest.param(
        "PF-SO-DRYRUN",
        UNKNOWN,
        inputs_with(dry_run=DryRun(status="failed", verdict=None)),
        id="failed",
    ),
    pytest.param("PF-SO-DRYRUN", UNKNOWN, inputs_with(dry_run=None), id="never-asked"),
    # PF-ENVELOPE: the geofence lies inside the envelope. It has no unknown state: an unknown
    # envelope fails it (FR-OPS-08), so the unknown inputs below are fails.
    pytest.param(
        "PF-ENVELOPE",
        FAIL,
        inputs_with(geofence_ring=ONE_METRE_OUTSIDE),
        id="vertex-one-metre-outside",
    ),
    pytest.param(
        "PF-ENVELOPE", FAIL, inputs_with(geofence_max_height_m=130.0), id="ceiling-above-envelope"
    ),
    pytest.param("PF-ENVELOPE", FAIL, stack_with(envelope=None), id="envelope-unknown-fails"),
    pytest.param(
        "PF-ENVELOPE",
        FAIL,
        stack_with(envelope_read_at=NOW - timedelta(seconds=4)),
        id="envelope-stale-fails",
    ),
    # PF-MODE: the stack's simulator mode is known.
    pytest.param("PF-MODE", FAIL, status_with(simulator_mode="yes"), id="mode-not-a-boolean"),
    pytest.param("PF-MODE", UNKNOWN, status_with(simulator_mode=None), id="simulator-mode-null"),
    pytest.param("PF-MODE", UNKNOWN, stack_with(status=None), id="mode-status-not-read"),
    # PF-SIMULATOR: the phone's simulator agrees with the stack's mode.
    pytest.param(
        "PF-SIMULATOR",
        FAIL,
        status_with(simulator_active=False),
        id="simulator-mode-but-phone-off",
    ),
    pytest.param(
        "PF-SIMULATOR",
        FAIL,
        status_with(simulator_mode=False),
        id="real-mode-but-phone-simulator-on",
    ),
    pytest.param("PF-SIMULATOR", UNKNOWN, status_with(simulator_active=None), id="active-null"),
    # PF-ARMED: the phone is armed with at least min_arming_left_s left.
    pytest.param("PF-ARMED", FAIL, status_with(armed=False), id="not-armed"),
    pytest.param(
        "PF-ARMED", FAIL, status_with(arming_remaining_s=119), id="one-second-under-minimum"
    ),
    pytest.param("PF-ARMED", UNKNOWN, status_with(armed=None), id="armed-null"),
    pytest.param("PF-ARMED", UNKNOWN, status_with(arming_remaining_s=None), id="left-null"),
    # PF-IDLE: the stack has no unfinished flight.
    pytest.param("PF-IDLE", FAIL, inputs_with(stack_busy=True), id="busy"),
    pytest.param("PF-IDLE", UNKNOWN, inputs_with(stack_busy=None), id="busy-unknown"),
    # PF-CLOCK: the stack's clock is within its bound (a warning).
    pytest.param(
        "PF-CLOCK",
        FAIL,
        status_with(warnings=[{"code": "clock_offset", "measured_ms": -2400, "limit_ms": 500}]),
        id="clock-warning",
    ),
    pytest.param("PF-CLOCK", UNKNOWN, status_with(clock_offset_ms=None), id="offset-null"),
    pytest.param(
        "PF-CLOCK",
        UNKNOWN,
        status_with(warnings=[{"measured_ms": -2400}]),
        id="warning-without-code",
    ),
    pytest.param("PF-CLOCK", UNKNOWN, status_with(warnings=None), id="warnings-null"),
]


@pytest.mark.parametrize(("check_id", "state", "change"), CASES)
def test_a_check_fails_or_is_unknown_when_its_input_says_so(
    check_id: str, state: str, change: Change
) -> None:
    assert judged(change(baseline()))[check_id].state == state


@pytest.mark.parametrize(("check_id", "state", "change"), CASES)
def test_a_blocking_case_never_passes_the_gate(check_id: str, state: str, change: Change) -> None:
    checks_ = judge(change(baseline()))
    if by_id(checks_)[check_id].blocking:
        assert not blocking_pass(checks_)


@pytest.mark.parametrize(("check_id", "state", "change"), CASES)
def test_the_values_of_every_case_are_json_able(check_id: str, state: str, change: Change) -> None:
    json.dumps([check.value for check in judge(change(baseline()))])


# ---------------------------------------------------------------- the details name what they judged


def test_the_envelope_names_the_vertex_one_metre_outside() -> None:
    # FR-OPS-08's acceptance: a geofence one metre outside the envelope's circle fails
    # PF-ENVELOPE naming that vertex.
    vertex = Geodetic(latitude_deg=ONE_METRE_OUTSIDE[2][1], longitude_deg=ONE_METRE_OUTSIDE[2][0])
    assert distance_m(CENTRE, vertex) == pytest.approx(2001.0, abs=1e-6)
    check = judged(inputs_with(geofence_ring=ONE_METRE_OUTSIDE)(baseline()))["PF-ENVELOPE"]
    assert check.state == "fail"
    assert check.detail == "Vertex 2 lies 1.0 m outside the envelope's 2000.0 m circle."


def test_a_vertex_exactly_on_the_radius_passes() -> None:
    # SO's rule: a value exactly at a limit passes (soc_geo.limits). The radius is the vertex's
    # own distance, computed the way the check computes it, so the excess is exactly zero.
    on_the_circle = destination(90.0, 2000.0)
    vertex = Geodetic(latitude_deg=on_the_circle[1], longitude_deg=on_the_circle[0])
    changed = inputs_with(geofence_ring=[*RING, on_the_circle])(baseline())
    changed = envelope_with(geofence_radius_m=distance_m(CENTRE, vertex))(stack_with()(changed))
    assert judged(changed)["PF-ENVELOPE"].state == "pass"


def test_the_ceiling_names_the_envelope_limit() -> None:
    check = judged(inputs_with(geofence_max_height_m=130.0)(baseline()))["PF-ENVELOPE"]
    assert "130.0 m" in check.detail and "120.0 m" in check.detail


def test_an_unknown_envelope_fails_naming_it() -> None:
    check = judged(stack_with(envelope=None)(baseline()))["PF-ENVELOPE"]
    assert check.state == "fail"
    assert "FR-OPS-08" in check.detail


def test_the_takeoff_names_the_tolerance() -> None:
    check = judged(sample_with(latitude_deg=FARM[0] + 0.0025)(baseline()))["PF-TAKEOFF"]
    assert "takeoff_tolerance_m 10.0 m" in check.detail


def test_the_takeoff_passes_within_the_tolerance_and_fails_beyond_it() -> None:
    inside = destination(0.0, 9.9)
    outside = destination(0.0, 10.1)
    near = sample_with(latitude_deg=inside[1], longitude_deg=inside[0])
    far = sample_with(latitude_deg=outside[1], longitude_deg=outside[0])
    assert judged(near(baseline()))["PF-TAKEOFF"].state == "pass"
    assert judged(far(baseline()))["PF-TAKEOFF"].state == "fail"


def test_the_arming_passes_at_exactly_the_minimum() -> None:
    assert judged(status_with(arming_remaining_s=120)(baseline()))["PF-ARMED"].state == "pass"


def test_the_arming_names_the_minimum_it_misses() -> None:
    check = judged(status_with(arming_remaining_s=119)(baseline()))["PF-ARMED"]
    assert "min_arming_left_s 120" in check.detail


def test_the_simulator_disagreement_says_what_the_operator_does() -> None:
    on = judged(status_with(simulator_active=False)(baseline()))["PF-SIMULATOR"]
    off = judged(status_with(simulator_mode=False)(baseline()))["PF-SIMULATOR"]
    assert "turn the phone's simulator on" in on.detail
    assert "turn the phone's simulator off" in off.detail


def test_a_mode_that_is_not_a_boolean_fails_naming_the_field() -> None:
    check = judged(status_with(simulator_mode="yes")(baseline()))["PF-MODE"]
    assert check.state == "fail"
    assert "simulator_mode" in check.detail


def test_a_dry_run_refusal_names_every_problem_its_verdict_gives() -> None:
    check = judged(
        inputs_with(dry_run=DryRun(status="rejected", verdict=verdict_rejected()))(baseline())
    )["PF-SO-DRYRUN"]
    assert check.state == "fail"
    assert "waypoint 3 is 2400.0 m from the geofence centre" in check.detail
    assert check.value == {
        "status": "rejected",
        "problems": [{"code": "outside_geofence", "waypoint_index": 3}],
    }


def test_a_refusal_whose_verdict_cannot_be_read_still_fails() -> None:
    check = judged(inputs_with(dry_run=DryRun(status="rejected", verdict=None))(baseline()))[
        "PF-SO-DRYRUN"
    ]
    assert check.state == "fail"


def test_the_wayline_problems_are_listed() -> None:
    problems = ["waypoint 3 leaves the geofence", "leg 4 is 1200.0 m"]
    check = judged(inputs_with(wayline_problems=problems)(baseline()))["PF-WAYLINE"]
    assert check.state == "fail"
    assert all(problem in check.detail for problem in problems)


# ---------------------------------------------------------- the geofence that cannot be judged


def test_a_self_intersecting_geofence_fails_naming_the_polygon() -> None:
    bowtie = [RING[0], RING[2], RING[1], RING[3]]
    check = judged(inputs_with(geofence_ring=bowtie)(baseline()))["PF-INSIDE"]
    assert check.state == "fail"
    assert "simple polygon" in check.detail


def test_an_empty_geofence_fails_naming_it() -> None:
    check = judged(inputs_with(geofence_ring=[])(baseline()))["PF-INSIDE"]
    assert check.state == "fail"
    assert "no vertices" in check.detail


def test_a_ceiling_that_is_not_above_zero_fails_naming_it() -> None:
    check = judged(inputs_with(geofence_max_height_m=0.0)(baseline()))["PF-INSIDE"]
    assert check.state == "fail"
    assert "above zero" in check.detail


def test_a_vertex_that_is_not_a_position_fails_naming_its_index() -> None:
    bad = [*RING[:3], [FARM[1], 95.0]]
    check = judged(inputs_with(geofence_ring=bad)(baseline()))["PF-ENVELOPE"]
    assert check.state == "fail"
    assert "vertex 3 is not a position" in check.detail


# ---------------------------------------------------------------- a known shortfall beats a gap


def test_a_satellite_shortfall_fails_though_the_quality_is_missing() -> None:
    # A measured shortfall is a fail; a missing value cannot undo it (the rule of soc_geo.fence).
    changed = sample_with(satellites=11, gps_quality=None)(baseline())
    assert judged(changed)["PF-GNSS"].state == "fail"


def test_a_clock_warning_fails_even_without_an_offset() -> None:
    changed = status_with(
        clock_offset_ms=None,
        warnings=[{"code": "clock_offset", "measured_ms": -2400, "limit_ms": 500}],
    )(baseline())
    assert judged(changed)["PF-CLOCK"].state == "fail"


# ---------------------------------------------------------------- FR-SAF-02: never stale as live


@pytest.mark.parametrize("threshold_offset_ms", [0, 1])
def test_a_sample_exactly_at_the_threshold_is_current_and_one_millisecond_past_it_is_not(
    threshold_offset_ms: int,
) -> None:
    received = NOW - timedelta(milliseconds=STALE_AFTER_MS + threshold_offset_ms)
    check = judged(aircraft_with(received_at=received)(baseline()))["PF-FRESH"]
    assert check.state == ("pass" if threshold_offset_ms == 0 else "fail")


def test_a_frozen_feed_never_passes_a_sample_dependent_check() -> None:
    frozen = aircraft_with(received_at=NOW - timedelta(seconds=10))(baseline())
    checks_ = judged(frozen)
    assert checks_["PF-FRESH"].state == "fail"
    for check_id in SAMPLE_DEPENDENT[1:]:
        assert checks_[check_id].state == "unknown", check_id
    assert not blocking_pass(judge(frozen))


def test_a_status_read_too_long_ago_never_passes_what_it_reports() -> None:
    stale = stack_with(status_read_at=NOW - timedelta(seconds=10))(baseline())
    checks_ = judged(stale)
    for check_id in STATUS_DEPENDENT:
        assert checks_[check_id].state == "unknown", check_id
    assert not blocking_pass(judge(stale))


def test_an_envelope_read_too_long_ago_fails_the_envelope() -> None:
    stale = stack_with(envelope_read_at=NOW - timedelta(seconds=10))(baseline())
    assert judged(stale)["PF-ENVELOPE"].state == "fail"


def test_a_status_with_no_read_time_is_not_current() -> None:
    no_time = stack_with(status_read_at=None)(baseline())
    assert judged(no_time)["PF-MODE"].state == "unknown"


def test_a_sample_read_from_the_future_is_not_current() -> None:
    future = aircraft_with(received_at=NOW + timedelta(seconds=10))(baseline())
    assert judged(future)["PF-FRESH"].state == "unknown"


def test_a_malformed_status_fails_every_check_that_reads_it() -> None:
    malformed = status_with(simulator_mode="yes")(baseline())
    checks_ = judged(malformed)
    for check_id in STATUS_DEPENDENT:
        assert checks_[check_id].state == "fail", check_id


# ---------------------------------------------------------------- PF-MODE and the prepare


def test_an_unknown_mode_blocks_every_prepare() -> None:
    # FR-SAF-04: with the mode unknown, nothing is prepared.
    unknown = status_with(simulator_mode=None)(baseline())
    assert judged(unknown)["PF-MODE"].state == "unknown"
    assert not blocking_pass(judge(unknown))


def test_both_modes_pass_pf_mode() -> None:
    assert (
        judged(status_with(simulator_mode=False, simulator_active=False)(baseline()))[
            "PF-MODE"
        ].state
        == "pass"
    )
    assert judged(baseline())["PF-MODE"].state == "pass"


def test_the_grounded_modes_pass_and_the_others_fail() -> None:
    for code in (0, 1, 2):
        assert judged(sample_with(mode_code=code)(baseline()))["PF-GROUNDED"].state == "pass"
    for code in (3, 5, 16):
        assert judged(sample_with(mode_code=code)(baseline()))["PF-GROUNDED"].state == "fail"


def test_a_boolean_is_not_a_mode_code() -> None:
    assert judged(sample_with(mode_code=True)(baseline()))["PF-GROUNDED"].state == "fail"


# ---------------------------------------------------------------- PF-CLOCK never blocks


def test_a_failing_clock_does_not_block() -> None:
    clock = status_with(warnings=[{"code": "clock_offset", "measured_ms": -2400, "limit_ms": 500}])
    checks_ = judge(clock(baseline()))
    assert by_id(checks_)["PF-CLOCK"].state == "fail"
    assert blocking_pass(checks_)


def test_a_failing_blocking_check_blocks() -> None:
    checks_ = judge(stack_with(link_state="displaced")(baseline()))
    assert by_id(checks_)["PF-LINK"].state == "fail"
    assert not blocking_pass(checks_)


# ---------------------------------------------------------------- the module's own surface


def test_the_same_inputs_judged_later_go_stale() -> None:
    # `now` is an input: the checks read no clock, so judging later is judging with a later `now`.
    later = replace(baseline(), now=NOW + timedelta(hours=1))
    assert judged(later)["PF-FRESH"].state == "fail"
    assert judged(baseline())["PF-FRESH"].state == "pass"
