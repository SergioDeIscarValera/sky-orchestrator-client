"""The console's bakes pass SOC's validator (FR-WAY-07, FR-WAY-08, ADR-0009).

contracts/geometry/bake.json holds designs and what the TypeScript bake gives them;
this checks every one independently: the bake follows the design schema, its
violations are exactly the ones the Python validator finds, its distance and duration
are in Sky Orchestrator's metric, no leg is longer than the envelope allows unless
reported, and no two points are closer than half a metre. A bake with no waypoint is
never a plan: the schema refuses it.
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
SCHEMA = jsonschema_rs.validator_for(
    json.loads((CONTRACTS / "geometry" / "design.schema.json").read_text(encoding="utf-8"))
)
ORIGIN = Geodetic(**VECTORS["origin"])
#: Points closer than this merge (FR-WAY-07).
MERGE_M = 0.5


def envelope_of(raw: dict[str, Any]) -> Envelope:
    return Envelope(**{**raw, "geofence_center": Geodetic(**raw["geofence_center"])})


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["name"])
def test_every_bake_is_what_the_validator_finds_in_sky_orchestrators_metric(
    case: dict[str, Any],
) -> None:
    baked = case["baked"]
    errors = list(SCHEMA.iter_errors({"design": case["design"], "baked": baked}))
    rules = [(v["rule"], v.get("waypoint_index")) for v in baked["violations"]]
    if not baked["waypoints"]:
        assert ("no_waypoints", None) in rules
        assert errors != []
        return
    assert errors == []
    envelope = envelope_of(case["envelope"])
    found = violations(plan_of(baked), envelope)
    assert [(v.rule, v.waypoint_index) for v in found] == rules
    positions = [Geodetic(w["latitude_deg"], w["longitude_deg"]) for w in baked["waypoints"]]
    legs = [
        distance_m(a, b)
        for a, b in itertools.pairwise([Geodetic(**baked["reference_point"]), *positions])
    ]
    assert math.fsum(legs) == pytest.approx(baked["distance_m"], abs=1e-6)
    assert baked["duration_s"] == pytest.approx(baked["distance_m"] / baked["speed_ms"])
    if "leg_too_long" not in {rule for rule, _ in rules}:
        assert max(legs) <= envelope.max_leg_m
    placed = [east_north(ORIGIN, position) for position in positions]
    for a, b in itertools.pairwise(placed):
        assert math.hypot(b.east_m - a.east_m, b.north_m - a.north_m) >= MERGE_M - 1e-9
    assert [w["index"] for w in baked["waypoints"]] == list(range(len(positions)))
