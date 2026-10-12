"""The plane's predicates, held to contracts/geometry/planar.json (ADR-0009)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

from soc_geo.planar import (
    Point,
    leg_clearance,
    locate,
    orientation,
    perimeter,
    problems,
    segments_meet,
    signed_area,
)

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "geometry" / "planar.json"
GOLDEN: dict[str, Any] = json.loads(VECTORS.read_text(encoding="utf-8"))
TOLERANCE = GOLDEN["tolerance_m"]
POLYGONS: dict[str, list[Point]] = {
    case["name"]: [(x, y) for x, y in case["polygon"]] for case in GOLDEN["polygons"]
}


def oracle_vectors() -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location(
        "planar_oracle", Path(__file__).with_name("planar_oracle.py")
    )
    assert spec is not None and spec.loader is not None
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    fresh: dict[str, Any] = oracle.vectors()
    return fresh


@pytest.mark.parametrize("case", GOLDEN["polygons"], ids=lambda case: case["name"])
def test_each_polygon_simple_or_not_with_its_edges_area_and_perimeter(case: dict[str, Any]) -> None:
    polygon = POLYGONS[case["name"]]
    found = problems(polygon)
    assert sorted({problem.rule for problem in found}) == case["rules"]
    if case.get("crossing_edges") is not None:
        crossing = [list(p.edges) for p in found if p.rule == "edges_meet"]
        assert crossing == case["crossing_edges"]
    if case["simple"]:
        assert abs(signed_area(polygon)) == pytest.approx(case["area_m2"], abs=TOLERANCE)
        assert (signed_area(polygon) > 0) == case["counter_clockwise"]
    if "perimeter_m" in case:
        assert perimeter(polygon) == pytest.approx(case["perimeter_m"], abs=TOLERANCE)


@pytest.mark.parametrize("case", GOLDEN["points"])
def test_each_point_located_inside_on_or_outside(case: dict[str, Any]) -> None:
    x, y = case["point"]
    assert locate(POLYGONS[case["polygon"]], (x, y)) == case["place"]


@pytest.mark.parametrize("case", GOLDEN["legs"])
def test_each_leg_with_its_clearance_or_none_when_it_leaves(case: dict[str, Any]) -> None:
    (ax, ay), (bx, by) = case["from"], case["to"]
    clearance = leg_clearance(POLYGONS[case["polygon"]], (ax, ay), (bx, by))
    if case["clearance_m"] is None:
        assert clearance is None
    else:
        assert clearance == pytest.approx(case["clearance_m"], abs=TOLERANCE)


def test_a_leg_jumping_the_arms_of_a_u_leaves_it_though_both_ends_are_inside() -> None:
    u = POLYGONS["u"]
    assert locate(u, (15.0, 90.0)) == locate(u, (85.0, 90.0)) == "inside"
    assert leg_clearance(u, (15.0, 90.0), (85.0, 90.0)) is None


def test_the_orientation_is_exact_where_floats_would_round() -> None:
    # Points a tiny step off a long line: the float determinant cancels to zero or to
    # the wrong sign; the exact one does not.
    a, b = (0.5, 0.5), (12.0, 12.0)
    c = (24.0, 24.0 + 2.0**-48)
    assert orientation(a, b, c) == 1
    assert orientation(a, b, (24.0, 24.0)) == 0
    assert orientation(b, a, c) == -1
    near = [(0.5 + i * 2.0**-53, 0.5) for i in range(1, 4)]
    signs = {orientation((12.0, 12.0), (24.0, 24.0), point) for point in near}
    assert signs == {-1}


def test_touching_segments_meet_and_parallel_ones_do_not() -> None:
    assert segments_meet((0, 0), (10, 0), (10, 0), (10, 10))
    assert segments_meet((0, 0), (10, 0), (5, 0), (15, 0))
    assert not segments_meet((0, 0), (10, 0), (0, 1), (10, 1))
    assert not segments_meet((0, 0), (10, 0), (11, 0), (20, 0))


def test_the_vectors_are_what_shapely_says_today() -> None:
    assert oracle_vectors() == GOLDEN
