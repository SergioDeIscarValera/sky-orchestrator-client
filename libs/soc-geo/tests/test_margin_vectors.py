"""The geofences the console generates pass SOC's validator (FR-GEO-03, ADR-0009).

contracts/geometry/margin.json holds what the TypeScript generator gives for each case;
this checks every one independently, with the Python predicates: a generator bug can
only make a geofence the validator refuses, never one it accepts.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

import pytest

from soc_geo.planar import Point, leg_clearance, locate, problems, signed_area

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "geometry" / "margin.json"
CASES: list[dict[str, Any]] = json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]
#: The generator's corners are computed in floats; the margin is metres.
ROUNDING_M = 1e-9


def points(raw: list[list[float]]) -> list[Point]:
    return [(x, y) for x, y in raw]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_every_generated_geofence_holds_its_waylines_at_the_margin(case: dict[str, Any]) -> None:
    fence = points(case["fence"])
    inner = points(case["points"])
    assert problems(fence) == []
    assert signed_area(fence) > 0
    assert len(fence) <= case["max_vertices"]
    assert all(locate(fence, point) == "inside" for point in inner)
    legs = [*itertools.combinations(inner, 2), *((point, point) for point in inner)]
    clearances = [leg_clearance(fence, a, b) for a, b in legs]
    assert None not in clearances
    assert min(c for c in clearances if c is not None) >= case["margin_m"] - ROUNDING_M
