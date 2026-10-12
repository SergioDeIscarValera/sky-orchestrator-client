"""The console's bakes and flights pass SOC's validator (FR-WAY-07, FR-WAY-08, ADR-0009).

contracts/geometry/bake.json holds designs, the waylines the TypeScript bake gives them and
the flights an operation makes of them; this checks every one independently. A bake
follows the schema's ``baked`` definition, climbs straight up above its takeoff first, flies
no leg on a slant, and its distance is Sky Orchestrator's, from the takeoff. A flight
follows ``flight``: it is the bake's waypoints, untouched and in order, with a leg longer
than the envelope allows split, its violations exactly the ones the Python validator finds,
its distance and duration in Sky Orchestrator's metric. No two points are closer than half
a metre unless one is straight above the other. A design with nothing drawn bakes to no
wayline, and its flight is never a plan: the schema refuses it.
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest

from soc_geo.limits import Envelope, plan_of, violations
from soc_geo.projection import Geodetic, east_north
from soc_geo.sphere import distance_m

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
VECTORS: dict[str, Any] = json.loads(
    (CONTRACTS / "geometry" / "bake.json").read_text(encoding="utf-8")
)
DESIGN_SCHEMA: dict[str, Any] = json.loads(
    (CONTRACTS / "geometry" / "design.schema.json").read_text(encoding="utf-8")
)
SCHEMA = jsonschema_rs.validator_for(DESIGN_SCHEMA)
#: The flight's own definition, checked on its own: no document holds one beside a design.
FLIGHT_SCHEMA = jsonschema_rs.validator_for(
    {
        "$schema": DESIGN_SCHEMA["$schema"],
        "$id": DESIGN_SCHEMA["$id"],
        "$defs": DESIGN_SCHEMA["$defs"],
        "$ref": "#/$defs/flight",
    }
)


def geodetic(position: list[float]) -> Geodetic:
    """A stored position, [longitude, latitude] in GeoJSON order."""
    longitude, latitude = position
    return Geodetic(latitude, longitude)


ORIGIN = geodetic(VECTORS["origin"])
#: Points closer than this merge (FR-WAY-07).
MERGE_M = 0.5
#: The cases flown, beside the one with nothing drawn.
DRAWN = [case for case in VECTORS["cases"] if case["baked"] is not None]


def envelope_of(raw: dict[str, Any]) -> Envelope:
    return Envelope(**{**raw, "geofence_center": Geodetic(**raw["geofence_center"])})


def legs_m(start: list[float], waypoints: list[dict[str, Any]]) -> list[float]:
    """From the start through every waypoint, in Sky Orchestrator's metric."""
    positions = [geodetic(start), *(geodetic(w["position"]) for w in waypoints)]
    return [distance_m(a, b) for a, b in itertools.pairwise(positions)]


def assert_points_apart_and_indexed(waypoints: list[dict[str, Any]]) -> None:
    for w, v in itertools.pairwise(waypoints):
        a, b = (east_north(ORIGIN, geodetic(x["position"])) for x in (w, v))
        apart = math.hypot(b.east_m - a.east_m, b.north_m - a.north_m) >= MERGE_M - 1e-9
        # Closer only straight above one another: a climb or a descent where it is.
        assert apart or (w["position"] == v["position"] and w["height_m"] != v["height_m"])
    assert [w["index"] for w in waypoints] == list(range(len(waypoints)))


def assert_level_or_vertical(waypoints: list[dict[str, Any]]) -> None:
    """No leg on a slant: each keeps its height, or keeps its place and climbs or descends."""
    for w, v in itertools.pairwise(waypoints):
        assert w["height_m"] == v["height_m"] or w["position"] == v["position"], (w, v)


def unindexed(waypoint: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in waypoint.items() if key != "index"}


def test_the_vectors_cover_a_split_a_violation_and_nothing_drawn() -> None:
    assert len(DRAWN) == len(VECTORS["cases"]) - 1
    assert any(len(c["flight"]["waypoints"]) > len(c["baked"]["waypoints"]) for c in DRAWN)
    assert any(c["flight"]["violations"] for c in DRAWN)


@pytest.mark.parametrize("case", DRAWN, ids=lambda case: case["name"])
def test_every_bake_follows_the_schema_and_measures_from_the_takeoff(
    case: dict[str, Any],
) -> None:
    baked = case["baked"]
    assert list(SCHEMA.iter_errors({"design": case["design"], "baked": baked})) == []
    legs = legs_m(case["design"]["takeoff"], baked["waypoints"])
    assert math.fsum(legs) == pytest.approx(baked["distance_m"], abs=1e-6)
    assert_points_apart_and_indexed(baked["waypoints"])


@pytest.mark.parametrize("case", DRAWN, ids=lambda case: case["name"])
def test_every_bake_climbs_straight_up_from_its_takeoff_and_never_on_a_slant(
    case: dict[str, Any],
) -> None:
    design, waypoints = case["design"], case["baked"]["waypoints"]
    # Right above the takeoff first; a point drawn there stands in for it.
    assert legs_m(design["takeoff"], waypoints[:1])[0] < MERGE_M
    assert_level_or_vertical(waypoints)
    assert_level_or_vertical(case["flight"]["waypoints"])


@pytest.mark.parametrize("case", DRAWN, ids=lambda case: case["name"])
def test_every_flight_is_its_bake_flown_as_the_operation_says(case: dict[str, Any]) -> None:
    baked, flight, operation = case["baked"], case["flight"], case["operation"]
    assert list(FLIGHT_SCHEMA.iter_errors(flight)) == []
    assert flight["reference_point"] == case["design"]["takeoff"]
    for key in ("takeoff_security_height_m", "speed_ms", "finish_action"):
        assert flight[key] == operation[key], key
    # A flight only adds points: the bake's own fly as baked, in order.
    flown = iter(unindexed(w) for w in flight["waypoints"])
    assert all(unindexed(w) in flown for w in baked["waypoints"])
    envelope = envelope_of(case["envelope"])
    longest = max(legs_m(case["design"]["takeoff"], baked["waypoints"]))
    if longest <= envelope.max_leg_m * (1 - 0.01):
        assert flight["waypoints"] == baked["waypoints"]


@pytest.mark.parametrize("case", DRAWN, ids=lambda case: case["name"])
def test_every_flight_is_what_the_validator_finds_in_sky_orchestrators_metric(
    case: dict[str, Any],
) -> None:
    flight = case["flight"]
    rules = [(v["rule"], v.get("waypoint_index")) for v in flight["violations"]]
    envelope = envelope_of(case["envelope"])
    found = violations(plan_of(flight), envelope)
    assert [(v.rule, v.waypoint_index) for v in found] == rules
    legs = legs_m(flight["reference_point"], flight["waypoints"])
    assert math.fsum(legs) == pytest.approx(flight["distance_m"], abs=1e-6)
    assert flight["duration_s"] == pytest.approx(flight["distance_m"] / flight["speed_ms"])
    if "leg_too_long" not in {rule for rule, _ in rules}:
        assert max(legs) <= envelope.max_leg_m
    assert_points_apart_and_indexed(flight["waypoints"])


def test_nothing_drawn_bakes_to_no_wayline_and_its_flight_is_refused() -> None:
    (case,) = [case for case in VECTORS["cases"] if case["baked"] is None]
    assert list(SCHEMA.iter_errors({"design": case["design"], "baked": None})) == []
    flight = case["flight"]
    assert flight["waypoints"] == []
    assert ("no_waypoints", None) in [
        (v["rule"], v.get("waypoint_index")) for v in flight["violations"]
    ]
    assert list(FLIGHT_SCHEMA.iter_errors(flight)) != []
