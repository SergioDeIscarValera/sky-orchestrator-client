"""What an operation must hold before it is planned and before it flies (FR-OPS-03, FR-WAY-08).

The console is the only generator (ADR-0009): it flies the wayline for the operation, its
bake from the takeoff at the operation's height and the assignment's speed, legs longer
than the stack allows split, and stores the flight on the assignment. soc-operations never
makes geometry; it holds that flight to everything it must be, independently:

- what Sky Orchestrator's file subset can fly, and no violation (the flight file builder
  refuses anything else, naming it);
- the operation's own figures: the wayline's takeoff as its reference point, the
  operation's height, the assignment's speed, a return home at the end (FR-OPS-01);
- the bake it was flown from: every baked waypoint, in order, exactly as baked, the flight
  only adding the points that split a leg; no leg on a slant (FR-WAY-01);
- the stack's envelope, as Sky Orchestrator judges it (soc_geo.limits);
- the operation's geofence: the takeoff and every waypoint inside it, every leg inside it
  (a leg between a U's arms leaves it with both ends inside), no height above its ceiling.

Each problem is one sentence naming what is wrong and where; an empty list is a pass.
Nothing here reads the database or the clock.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from soc_geo import fence
from soc_geo.limits import Envelope, plan_of, violations
from soc_geo.planar import Point, leg_clearance, problems
from soc_geo.projection import Geodetic, east_north
from soc_operations import flight_files

#: How every flight of an operation ends (FR-OPS-01).
RETURN_HOME = "return_home"


@dataclass(frozen=True)
class GeofenceView:
    """The operation's geofence as stored (IR-GEO): a ring of [longitude, latitude], not closed."""

    polygon: Sequence[Sequence[float]]
    max_height_m: float
    retired: bool


@dataclass(frozen=True)
class WaylineView:
    """The assigned wayline as saved (IR-WAY): its takeoff and its baked waypoints."""

    name: str
    takeoff: Sequence[float]
    waypoints: Sequence[Mapping[str, Any]]
    retired: bool


@dataclass(frozen=True)
class FleetView:
    name: str
    retired: bool


@dataclass(frozen=True)
class AssignmentView:
    speed_ms: float | None
    flight: Mapping[str, Any] | None
    wayline: WaylineView
    fleet: FleetView


@dataclass(frozen=True)
class OperationView:
    name: str
    takeoff_security_height_m: float | None
    geofence: GeofenceView | None
    assignments: Sequence[AssignmentView]
    #: Pilots who are live members with editor or above: the ones who can command (FR-CMD-01).
    pilots: int


def envelope_of(read: Mapping[str, Any] | None) -> Envelope | None:
    """The stack's envelope from what `GET /v1/envelope` said, or None when it is unknown."""
    if read is None:
        return None
    limits = read["envelope"]
    centre = limits["geofence_center"]
    return Envelope(
        geofence_center=Geodetic(centre["latitude_deg"], centre["longitude_deg"]),
        geofence_radius_m=float(limits["geofence_radius_m"]),
        max_height_m=float(limits["max_height_m"]),
        max_home_distance_m=float(limits["max_home_distance_m"]),
        max_leg_m=float(limits["max_leg_m"]),
        max_transit_m=float(limits["max_transit_m"]),
        max_total_distance_m=float(limits["max_total_distance_m"]),
        max_waypoints=int(limits["max_waypoints"]),
        max_horizontal_speed_ms=float(limits["max_horizontal_speed_ms"]),
    )


def plan_problems(operation: OperationView, envelope: Envelope | None) -> list[str]:
    """Everything that keeps the operation from being planned (FR-OPS-03), each named."""
    found: list[str] = []
    if operation.takeoff_security_height_m is None:
        found.append("the operation has no height")
    geofence = operation.geofence
    if geofence is None:
        found.append("the operation has no geofence")
    else:
        found.extend(geofence_problems(geofence, envelope))
    if not operation.assignments:
        found.append("the operation assigns no wayline to a fleet")
    for assignment in operation.assignments:
        found.extend(assignment_problems(operation, assignment, envelope))
    if operation.pilots < 1:
        found.append("the operation has no pilot who is an editor of its organization")
    return found


def geofence_problems(geofence: GeofenceView, envelope: Envelope | None) -> list[str]:
    """A geofence it can fly in (FR-GEO-04): live, simple, its ceiling within the stack's."""
    found: list[str] = []
    if geofence.retired:
        found.append("the geofence is retired")
    origin = _origin(geofence.polygon)
    if origin is None:
        return [*found, "the geofence has no ring to judge"]
    ring = [_point(origin, position) for position in geofence.polygon]
    for problem in problems(ring):
        edges = ", ".join(str(edge + 1) for edge in problem.edges)
        found.append(
            f"the geofence is not a simple polygon: {problem.rule.replace('_', ' ')}"
            + (f" (edges {edges})" if edges else "")
        )
    if not (math.isfinite(geofence.max_height_m) and geofence.max_height_m > 0):
        found.append("the geofence's ceiling is not above zero")
    elif envelope is not None and geofence.max_height_m > envelope.max_height_m:
        found.append(
            f"the geofence's ceiling of {_m(geofence.max_height_m)} is above the stack's"
            f" {_m(envelope.max_height_m)}"
        )
    return found


def assignment_problems(
    operation: OperationView, assignment: AssignmentView, envelope: Envelope | None
) -> list[str]:
    """What keeps one assignment from flying: its wayline, its fleet, its speed, its flight."""
    found: list[str] = []
    if assignment.wayline.retired:
        found.append(f"the wayline {assignment.wayline.name} is retired")
    if assignment.fleet.retired:
        found.append(f"the fleet {assignment.fleet.name} is retired")
    if assignment.speed_ms is None:
        found.append(f"the fleet {assignment.fleet.name} has no speed for its wayline")
    found.extend(flight_problems(operation, assignment, envelope))
    return found


def flight_problems(
    operation: OperationView, assignment: AssignmentView, envelope: Envelope | None
) -> list[str]:
    """Everything wrong with the flight the console stored for this assignment (PF-WAYLINE)."""
    flight = assignment.flight
    if flight is None:
        return ["the wayline has not been flown for this operation yet"]
    try:
        flight_files.build(flight, name=assignment.wayline.name)
    except ValueError as refusal:
        return [f"the flight cannot be flown: {refusal}"]
    found = _figures(operation, assignment, flight)
    found.extend(_kept_bake(assignment.wayline, flight))
    found.extend(_level_or_vertical(flight))
    if envelope is None:
        found.append("the stack's envelope is not known, so the flight cannot be judged by it")
    else:
        broken = violations(plan_of(flight), envelope)
        found.extend(f"the stack's envelope: {each.message}" for each in broken)
    if operation.geofence is not None:
        found.extend(_inside(operation.geofence, flight))
    return found


def _figures(
    operation: OperationView, assignment: AssignmentView, flight: Mapping[str, Any]
) -> list[str]:
    found: list[str] = []
    if list(flight["reference_point"]) != list(assignment.wayline.takeoff):
        found.append("the flight does not start from the wayline's takeoff")
    if flight["takeoff_security_height_m"] != operation.takeoff_security_height_m:
        found.append("the flight does not climb to the operation's height")
    if flight["speed_ms"] != assignment.speed_ms:
        found.append("the flight does not fly at the assignment's speed")
    if flight["finish_action"] != RETURN_HOME:
        found.append("the flight does not return home at its end")
    return found


def _kept_bake(wayline: WaylineView, flight: Mapping[str, Any]) -> list[str]:
    """The bake's waypoints, every one, in order, as baked: a flight only adds split points."""
    flown = iter([(list(w["position"]), w["height_m"]) for w in flight["waypoints"]])
    for index, baked in enumerate(wayline.waypoints):
        wanted = (list(baked["position"]), baked["height_m"])
        if not any(each == wanted for each in flown):
            return [f"the flight does not fly the wayline's waypoint {index} as baked"]
    return []


def _level_or_vertical(flight: Mapping[str, Any]) -> list[str]:
    """No leg on a slant: each keeps its height, or keeps its place (FR-WAY-01)."""
    found: list[str] = []
    waypoints = flight["waypoints"]
    for before, after in itertools.pairwise(waypoints):
        level = before["height_m"] == after["height_m"]
        vertical = list(before["position"]) == list(after["position"])
        if not (level or vertical):
            found.append(f"the leg into waypoint {after['index']} climbs or descends on a slant")
    return found


def _inside(geofence: GeofenceView, flight: Mapping[str, Any]) -> list[str]:
    """The takeoff, every waypoint and every leg inside the geofence, under its ceiling."""
    origin = _origin(geofence.polygon)
    if origin is None:
        return []
    try:
        judged = fence.geofence_of(origin, geofence.polygon, geofence.max_height_m)
    except ValueError as refusal:
        return [f"the geofence cannot be judged: {refusal}"]
    ring = [_point(origin, position) for position in geofence.polygon]
    found: list[str] = []
    takeoff = _geodetic(flight["reference_point"])
    if fence.judge(judged, takeoff, 0.0, 0.0).verdict == fence.Verdict.OUTSIDE:
        found.append("the takeoff is outside the geofence")
    if flight["takeoff_security_height_m"] > geofence.max_height_m:
        found.append(
            f"the climb to {_m(flight['takeoff_security_height_m'])} is above the geofence's"
            f" ceiling of {_m(geofence.max_height_m)}"
        )
    previous = _point(origin, flight["reference_point"])
    for waypoint in flight["waypoints"]:
        index = waypoint["index"]
        judgement = fence.judge(judged, _geodetic(waypoint["position"]), waypoint["height_m"], 0.0)
        if judgement.verdict == fence.Verdict.OUTSIDE:
            found.append(f"waypoint {index} is outside the geofence: {judgement.reason}")
        here = _point(origin, waypoint["position"])
        if here != previous and leg_clearance(ring, previous, here) is None:
            found.append(f"the leg into waypoint {index} leaves the geofence")
        previous = here
    return found


def _origin(polygon: Sequence[Sequence[float]]) -> Geodetic | None:
    """The geofence's first vertex: the frame the ring is judged on, a few hundred metres across."""
    if not polygon:
        return None
    return _geodetic(polygon[0])


def _geodetic(position: Sequence[float]) -> Geodetic:
    longitude, latitude = position
    return Geodetic(latitude, longitude)


def _point(origin: Geodetic, position: Sequence[float]) -> Point:
    placed = east_north(origin, _geodetic(position))
    return (placed.east_m, placed.north_m)


def _m(value: float) -> str:
    return f"{value:g} m"
