"""Sky Orchestrator's flight envelope, checked as it checks it (FR-WAY-08, ADR-0009).

so-wayline judges every flight file against its stack's envelope (its envelope.py),
and the phone again at load. SOC checks the same limits first, in the same order, with
the same metric (`soc_geo.sphere`) and the same semantics, a value exactly at a limit
passing, and names each violation by the code Sky Orchestrator would give it, so a
wayline SOC accepts is not refused there for a reason SOC could have seen. Sky
Orchestrator's own verdict is still asked for and shown beside SOC's (FR-LNK-09).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from soc_geo.projection import Geodetic
from soc_geo.sphere import distance_m


@dataclass(frozen=True)
class Envelope:
    """A stack's limits, under so-wayline's configuration keys (its Envelope schema)."""

    geofence_center: Geodetic
    geofence_radius_m: float
    max_height_m: float
    max_home_distance_m: float
    max_leg_m: float
    max_transit_m: float
    max_total_distance_m: float
    max_waypoints: int
    max_horizontal_speed_ms: float


@dataclass(frozen=True)
class Waypoint:
    index: int
    position: Geodetic
    height_m: float
    speed_ms: float | None = None


@dataclass(frozen=True)
class Plan:
    """What the envelope judges: Sky Orchestrator's mission plan, horizontally."""

    reference_point: Geodetic
    takeoff_security_height_m: float
    speed_ms: float
    waypoints: Sequence[Waypoint]


@dataclass(frozen=True)
class Violation:
    """A limit broken, by Sky Orchestrator's code for it, with the waypoint when it is one."""

    rule: str
    message: str
    waypoint_index: int | None = None


def _position(value: Sequence[float]) -> Geodetic:
    """A stored position, [longitude, latitude] in GeoJSON order."""
    longitude, latitude = value
    return Geodetic(latitude, longitude)


def plan_of(flight: Mapping[str, Any]) -> Plan:
    """A flight, the design schema's ``$defs.flight``, as the envelope judges it."""
    return Plan(
        reference_point=_position(flight["reference_point"]),
        takeoff_security_height_m=flight["takeoff_security_height_m"],
        speed_ms=flight["speed_ms"],
        waypoints=[
            Waypoint(w["index"], _position(w["position"]), w["height_m"], w.get("speed_ms"))
            for w in flight["waypoints"]
        ],
    )


def _m(value: float) -> str:
    return f"{value:.1f} m"


def violations(
    plan: Plan,
    envelope: Envelope,
    *,
    transitional_speed_ms: float | None = None,
    expected_takeoff: Geodetic | None = None,
) -> list[Violation]:
    """Every limit `plan` breaks, in Sky Orchestrator's order; none when it flies.

    The transit and every point's distance from home need the takeoff position: given
    `expected_takeoff`, they are checked against it, as Sky Orchestrator does at ingest;
    without it they are left to the aircraft, as there.
    """
    found: list[Violation] = []
    waypoints = plan.waypoints
    if len(waypoints) > envelope.max_waypoints:
        found.append(
            Violation(
                "too_many_waypoints",
                f"the wayline holds {len(waypoints)} waypoints;"
                f" max_waypoints is {envelope.max_waypoints}",
            )
        )
    if plan.takeoff_security_height_m > envelope.max_height_m:
        found.append(
            Violation(
                "takeoff_security_height_above_max",
                f"the takeoff security height {_m(plan.takeoff_security_height_m)}"
                f" is above max_height_m {_m(envelope.max_height_m)}",
            )
        )
    found += [
        Violation(
            "height_above_max",
            f"waypoint {w.index} is at {_m(w.height_m)},"
            f" above max_height_m {_m(envelope.max_height_m)}",
            w.index,
        )
        for w in waypoints
        if w.height_m > envelope.max_height_m
    ]
    points: list[tuple[int | None, Geodetic]] = [(None, plan.reference_point)]
    points += [(w.index, w.position) for w in waypoints]
    for index, point in points:
        distance = distance_m(envelope.geofence_center, point)
        if distance > envelope.geofence_radius_m:
            what = "the reference point" if index is None else f"waypoint {index}"
            found.append(
                Violation(
                    "outside_geofence",
                    f"{what} is {_m(distance)} from the geofence centre;"
                    f" the radius is {_m(envelope.geofence_radius_m)}",
                    index,
                )
            )
    previous, total = plan.reference_point, 0.0
    for w in waypoints:
        leg = distance_m(previous, w.position)
        total += leg
        if leg > envelope.max_leg_m:
            origin = "the reference point" if w.index == 0 else f"waypoint {w.index - 1}"
            found.append(
                Violation(
                    "leg_too_long",
                    f"the leg from {origin} to waypoint {w.index} is {_m(leg)};"
                    f" max_leg_m is {_m(envelope.max_leg_m)}",
                    w.index,
                )
            )
        previous = w.position
    if total > envelope.max_total_distance_m:
        found.append(
            Violation(
                "total_distance_too_long",
                f"the route is {_m(total)} from the reference point;"
                f" max_total_distance_m is {_m(envelope.max_total_distance_m)}",
            )
        )
    limit = envelope.max_horizontal_speed_ms
    speeds: list[tuple[int | None, str, float]] = [(None, "the wayline speed", plan.speed_ms)]
    if transitional_speed_ms is not None:
        speeds.append((None, "the WPML transitional speed", transitional_speed_ms))
    speeds += [
        (w.index, f"the leg into waypoint {w.index}", w.speed_ms)
        for w in waypoints
        if w.speed_ms is not None
    ]
    found += [
        Violation(
            "speed_above_max",
            f"{what} is {value:g} m/s; max_horizontal_speed_ms is {limit:g}",
            index,
        )
        for index, what, value in speeds
        if value > limit
    ]
    if expected_takeoff is not None:
        transit = distance_m(expected_takeoff, plan.reference_point)
        if transit > envelope.max_transit_m:
            found.append(
                Violation(
                    "transit_too_long",
                    f"the transit from the expected takeoff position is {_m(transit)};"
                    f" max_transit_m is {_m(envelope.max_transit_m)}",
                )
            )
        for index, point in points:
            distance = distance_m(expected_takeoff, point)
            if distance > envelope.max_home_distance_m:
                what = "the reference point" if index is None else f"waypoint {index}"
                found.append(
                    Violation(
                        "home_distance_too_far",
                        f"{what} is {_m(distance)} from the expected takeoff position;"
                        f" max_home_distance_m is {_m(envelope.max_home_distance_m)}",
                        index,
                    )
                )
    return found
