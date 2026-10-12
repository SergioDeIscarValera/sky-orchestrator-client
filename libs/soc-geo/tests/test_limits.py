"""Sky Orchestrator's envelope as SOC checks it (FR-WAY-08): one fixture per rule."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from soc_geo.limits import Envelope, Plan, Waypoint, plan_of, violations
from soc_geo.projection import Geodetic
from soc_geo.sphere import distance_m

#: contracts/flight-files' route: the route example's wayline, flown by an operation.
ROUTE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "flight-files"
    / "route-return-home"
    / "flight.json"
)
PLAN = plan_of(json.loads(ROUTE.read_text(encoding="utf-8")))
FARM = Geodetic(41.6523, -4.7245)
ROOMY = Envelope(
    geofence_center=FARM,
    geofence_radius_m=500.0,
    max_height_m=120.0,
    max_home_distance_m=500.0,
    max_leg_m=200.0,
    max_transit_m=200.0,
    max_total_distance_m=2000.0,
    max_waypoints=200,
    max_horizontal_speed_ms=15.0,
)


def tighter(**limits: Any) -> Envelope:
    return dataclasses.replace(ROOMY, **limits)


def rules(found: list[Any]) -> list[tuple[str, int | None]]:
    return [(violation.rule, violation.waypoint_index) for violation in found]


def test_the_example_bake_flies_in_a_roomy_envelope() -> None:
    assert violations(PLAN, ROOMY, transitional_speed_ms=5.0, expected_takeoff=FARM) == []


@pytest.mark.parametrize(
    ("envelope", "plan", "expected"),
    [
        (tighter(max_waypoints=3), PLAN, [("too_many_waypoints", None)]),
        (
            tighter(max_height_m=32.0),
            PLAN,
            [("height_above_max", 3)],
        ),
        (
            tighter(max_height_m=19.0),
            dataclasses.replace(
                PLAN,
                waypoints=[dataclasses.replace(w, height_m=10.0) for w in PLAN.waypoints],
            ),
            [("takeoff_security_height_above_max", None)],
        ),
        (
            tighter(geofence_radius_m=30.0),
            PLAN,
            # The climb above the centre, 27.8 m north and 16.6 m east are inside; 46.6 and
            # 37.4 m are not.
            [("outside_geofence", 2), ("outside_geofence", 3)],
        ),
        (tighter(max_leg_m=30.0), PLAN, [("leg_too_long", 2)]),
        (tighter(max_total_distance_m=100.0), PLAN, [("total_distance_too_long", None)]),
        (tighter(max_horizontal_speed_ms=4.0), PLAN, [("speed_above_max", None)]),
    ],
    ids=[
        "max_waypoints",
        "max_height_m",
        "takeoff_security_height",
        "geofence",
        "max_leg_m",
        "max_total_distance_m",
        "max_horizontal_speed_ms",
    ],
)
def test_each_rule_refuses_with_its_code_and_waypoint(
    envelope: Envelope, plan: Plan, expected: list[tuple[str, int | None]]
) -> None:
    assert rules(violations(plan, envelope)) == expected


def test_a_value_exactly_at_its_limit_passes_as_in_sky_orchestrator() -> None:
    at_limit = tighter(
        max_waypoints=len(PLAN.waypoints),
        max_height_m=max(w.height_m for w in PLAN.waypoints),
        max_leg_m=max(
            distance_m(a, b)
            for a, b in zip(
                [PLAN.reference_point, *(w.position for w in PLAN.waypoints)],
                [w.position for w in PLAN.waypoints],
                strict=False,
            )
        ),
        max_horizontal_speed_ms=PLAN.speed_ms,
    )
    assert violations(PLAN, at_limit) == []


def test_a_legs_speed_and_the_transitional_speed_are_held_to_the_limit() -> None:
    fast = dataclasses.replace(
        PLAN,
        waypoints=[*PLAN.waypoints[:2], dataclasses.replace(PLAN.waypoints[2], speed_ms=16.0)],
    )
    found = violations(fast, ROOMY, transitional_speed_ms=15.5)
    assert rules(found) == [("speed_above_max", None), ("speed_above_max", 2)]
    assert "the WPML transitional speed is 15.5 m/s" in found[0].message


def test_the_transit_and_the_distance_from_home_need_the_takeoff_position() -> None:
    far = Geodetic(41.6550, -4.7245)
    envelope = tighter(max_transit_m=100.0, max_home_distance_m=320.0)
    assert violations(PLAN, envelope) == []
    assert rules(violations(PLAN, envelope, expected_takeoff=far)) == [("transit_too_long", None)]
    points = [(None, PLAN.reference_point), *((w.index, w.position) for w in PLAN.waypoints)]
    beyond = [(index, distance_m(far, point)) for index, point in points]
    limit = 290.0
    envelope = tighter(max_transit_m=400.0, max_home_distance_m=limit)
    found = violations(PLAN, envelope, expected_takeoff=far)
    assert rules(found) == [("home_distance_too_far", i) for i, d in beyond if d > limit]
    assert len(found) >= 2


def test_a_position_that_is_not_one_is_refused_never_judged() -> None:
    broken = dataclasses.replace(PLAN, waypoints=[Waypoint(0, Geodetic(float("nan"), 0.0), 30.0)])
    with pytest.raises(ValueError, match="out of range"):
        violations(broken, ROOMY)
