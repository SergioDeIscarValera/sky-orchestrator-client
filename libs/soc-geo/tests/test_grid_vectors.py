"""The console's grid coverages pass SOC's checks (FR-WAY-05, ADR-0009).

contracts/geometry/grid.json holds what the TypeScript generator flies for each area;
this checks every one independently: every point inside the area, the lines parallel
at the spacing within 0.1 m, the outer lines within half a spacing of the area's
extent, and, unless an angle was given, no bearing of a half-degree sweep needing
fewer lines.
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any

import pytest

from soc_geo.planar import Point, locate

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "geometry" / "grid.json"
CASES: list[dict[str, Any]] = json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]
#: FR-WAY-05's acceptance: lines at the spacing within 0.1 m.
SPACING_TOLERANCE_M = 0.1


def across(angle_deg: float) -> Point:
    angle = math.radians(angle_deg)
    return (math.cos(angle), -math.sin(angle))


def offset(point: Point, axis: Point) -> float:
    return point[0] * axis[0] + point[1] * axis[1]


def lines_needed(area: list[Point], angle_deg: float, spacing_m: float) -> int:
    offsets = [offset(point, across(angle_deg)) for point in area]
    return max(1, math.ceil((max(offsets) - min(offsets)) / spacing_m - 1e-9))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_every_coverage_is_inside_parallel_at_its_spacing_and_needs_no_fewer_lines(
    case: dict[str, Any],
) -> None:
    area: list[Point] = [(x, y) for x, y in case["area"]]
    spacing = case["line_spacing_m"]
    angle = case["coverage"]["angleDeg"]
    lines: list[list[Point]] = [[(x, y) for x, y in line] for line in case["coverage"]["lines"]]
    axis = across(angle)
    assert all(locate(area, point) == "inside" for line in lines for point in line)
    offsets = []
    for line in lines:
        mine = [offset(point, axis) for point in line]
        assert max(mine) - min(mine) < 1e-6
        offsets.append(mine[0])
    for before, after in itertools.pairwise(offsets):
        spacings = (after - before) / spacing
        assert spacings > 0.5
        assert abs(spacings - round(spacings)) * spacing < SPACING_TOLERANCE_M
    extent = [offset(point, axis) for point in area]
    assert offsets[0] - min(extent) <= spacing / 2 + SPACING_TOLERANCE_M
    assert max(extent) - offsets[-1] <= spacing / 2 + SPACING_TOLERANCE_M
    if "angle_deg" not in case:
        fewest = min(lines_needed(area, step / 2, spacing) for step in range(360))
        assert lines_needed(area, angle, spacing) <= fewest
