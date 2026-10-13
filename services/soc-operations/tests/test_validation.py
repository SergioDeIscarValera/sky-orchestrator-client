"""What an operation must hold before it is planned and before it flies (FR-OPS-03, FR-WAY-08)."""

from __future__ import annotations

import copy
import dataclasses
from collections.abc import Callable
from typing import Any

import pytest

from soc_operations.testing import ENVELOPE, FLIGHT, SQUARE, operation
from soc_operations.validation import (
    FleetView,
    GeofenceView,
    OperationView,
    envelope_of,
    flight_problems,
    plan_problems,
)


def with_assignment(**changes: Any) -> OperationView:
    base = operation()
    return dataclasses.replace(
        base, assignments=[dataclasses.replace(base.assignments[0], **changes)]
    )


def with_flight(change: Callable[[dict[str, Any]], None]) -> OperationView:
    flight = copy.deepcopy(FLIGHT)
    change(flight)
    return with_assignment(flight=flight)


ENVELOPE_KNOWN = envelope_of(ENVELOPE)


def test_the_golden_pair_plans_clean_and_flies_clean() -> None:
    assert plan_problems(operation(), ENVELOPE_KNOWN) == []
    assert flight_problems(operation(), operation().assignments[0], ENVELOPE_KNOWN) == []


@pytest.mark.parametrize(
    ("planned", "named"),
    [
        (operation(takeoff_security_height_m=None), "has no height"),
        (operation(geofence=None), "has no geofence"),
        (operation(assignments=[]), "assigns no wayline"),
        (operation(pilots=0), "no pilot"),
        (with_assignment(speed_ms=None), "no speed"),
        (with_assignment(flight=None), "not been flown"),
        (
            operation(geofence=GeofenceView(polygon=SQUARE, max_height_m=60.0, retired=True)),
            "geofence is retired",
        ),
        (
            with_assignment(fleet=FleetView(name="Norte 1", retired=True)),
            "fleet Norte 1 is retired",
        ),
    ],
    ids=["height", "geofence", "assignment", "pilot", "speed", "flight", "retired-geofence",
         "retired-fleet"],
)  # fmt: skip
def test_each_missing_condition_is_refused_naming_it(planned: OperationView, named: str) -> None:
    """FR-OPS-03's acceptance: one fixture per missing condition, each refused with it named."""
    found = plan_problems(planned, ENVELOPE_KNOWN)
    assert any(named in problem for problem in found), found


def test_a_retired_wayline_is_named() -> None:
    base = operation()
    wayline = dataclasses.replace(base.assignments[0].wayline, retired=True)
    found = plan_problems(with_assignment(wayline=wayline), ENVELOPE_KNOWN)
    assert "the wayline Route is retired" in found


@pytest.mark.parametrize(
    ("change", "named"),
    [
        (
            lambda f: f.update(violations=[{"rule": "leg_too_long", "message": "x"}]),
            "cannot be flown",
        ),
        (lambda f: f.update(reference_point=[-4.7246, 41.6523]), "does not start from"),
        (lambda f: f.update(takeoff_security_height_m=25.0), "operation's height"),
        (lambda f: f.update(speed_ms=6.0), "assignment's speed"),
        (lambda f: f.update(finish_action="land"), "return home"),
        (lambda f: f["waypoints"].pop(2), "waypoint"),
        (lambda f: f["waypoints"][2].update(height_m=31.0), "waypoint 2 as baked"),
    ],
    ids=["violations", "takeoff", "height", "speed", "finish", "dropped", "moved"],
)
def test_a_flight_that_is_not_this_operations_flight_of_its_bake_is_refused(
    change: Callable[[dict[str, Any]], None], named: str
) -> None:
    found = plan_problems(with_flight(change), ENVELOPE_KNOWN)
    assert any(named in problem for problem in found), found


def test_a_leg_on_a_slant_is_refused() -> None:
    """FR-WAY-01: every leg level or straight up or down; a flight made otherwise is refused."""

    def slant(flight: dict[str, Any]) -> None:
        flight["waypoints"][2]["height_m"] = 33.0

    found = plan_problems(with_flight(slant), ENVELOPE_KNOWN)
    assert any("on a slant" in problem for problem in found), found


def test_the_stacks_envelope_judges_the_flight_and_unknown_cannot_judge() -> None:
    tight = copy.deepcopy(ENVELOPE)
    tight["envelope"]["max_leg_m"] = 30.0
    found = plan_problems(operation(), envelope_of(tight))
    assert any("leg" in problem and "stack's envelope" in problem for problem in found), found
    assert any("envelope is not known" in problem for problem in plan_problems(operation(), None))


def test_a_geofence_ceiling_above_the_stacks_is_refused() -> None:
    low = copy.deepcopy(ENVELOPE)
    low["envelope"]["max_height_m"] = 50.0
    found = plan_problems(operation(), envelope_of(low))
    assert "the geofence's ceiling of 60 m is above the stack's 50 m" in found


@pytest.mark.parametrize(
    ("polygon", "ceiling", "named"),
    [
        # The square's east half only: the route's east end is outside.
        ([[-4.7250, 41.6519], [-4.7242, 41.6519], [-4.7242, 41.6529], [-4.7250, 41.6529]], 60.0,
         "outside the geofence"),
        # Under 35 m: the climb to 35 m and the points there are above the ceiling.
        (SQUARE, 32.0, "outside the geofence"),
        # Under the operation's 20 m climb.
        (SQUARE, 18.0, "climb to 20 m is above"),
        # A bow-tie is not a polygon at all.
        ([[-4.7250, 41.6519], [-4.7235, 41.6529], [-4.7235, 41.6519], [-4.7250, 41.6529]], 60.0,
         "not a simple polygon"),
    ],
    ids=["waypoint-outside", "above-ceiling", "climb-above-ceiling", "bow-tie"],
)  # fmt: skip
def test_the_geofence_holds_the_takeoff_every_point_and_every_height(
    polygon: list[list[float]], ceiling: float, named: str
) -> None:
    fenced = operation(geofence=GeofenceView(polygon=polygon, max_height_m=ceiling, retired=False))
    found = plan_problems(fenced, ENVELOPE_KNOWN)
    assert any(named in problem for problem in found), found


def test_a_leg_between_a_us_arms_leaves_the_geofence_though_both_ends_are_inside() -> None:
    """The route's first leg runs east along 41.65255; a notch cut up from the south below it
    leaves both its ends inside and its middle outside."""
    notched = [
        [-4.7250, 41.6519], [-4.7235, 41.6519], [-4.7235, 41.6529], [-4.72420, 41.6529],
        [-4.72420, 41.65245], [-4.72435, 41.65245], [-4.72435, 41.6529], [-4.7250, 41.6529],
    ]  # fmt: skip
    fenced = operation(geofence=GeofenceView(polygon=notched, max_height_m=60.0, retired=False))
    found = plan_problems(fenced, ENVELOPE_KNOWN)
    assert any("leaves the geofence" in problem for problem in found), found


def test_a_takeoff_outside_the_geofence_is_named() -> None:
    north = [[-4.7250, 41.6524], [-4.7235, 41.6524], [-4.7235, 41.6529], [-4.7250, 41.6529]]
    fenced = operation(geofence=GeofenceView(polygon=north, max_height_m=60.0, retired=False))
    assert "the takeoff is outside the geofence" in plan_problems(fenced, ENVELOPE_KNOWN)
