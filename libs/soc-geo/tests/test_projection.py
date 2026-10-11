from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
from typing import Any

import pytest

from soc_geo.projection import EastNorth, Geodetic, east_north

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "geometry" / "projection.json"
GOLDEN: dict[str, Any] = json.loads(VECTORS.read_text(encoding="utf-8"))


def oracle_vectors() -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location("oracle", Path(__file__).with_name("oracle.py"))
    assert spec is not None and spec.loader is not None
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    fresh: dict[str, Any] = oracle.vectors()
    return fresh


def geodetic(value: dict[str, float]) -> Geodetic:
    return Geodetic(value["latitude_deg"], value["longitude_deg"])


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda case: case["name"])
def test_every_golden_vector_within_its_tolerance(case: dict[str, Any]) -> None:
    placed = east_north(geodetic(case["origin"]), geodetic(case["point"]))
    tolerance = GOLDEN["tolerance_m"]
    assert placed.east_m == pytest.approx(case["east_m"], abs=tolerance)
    assert placed.north_m == pytest.approx(case["north_m"], abs=tolerance)


def test_the_vectors_are_what_proj_says_today() -> None:
    fresh = oracle_vectors()
    assert [case["point"] for case in fresh["cases"]] == [case["point"] for case in GOLDEN["cases"]]
    for written, computed in zip(GOLDEN["cases"], fresh["cases"], strict=True):
        assert written["east_m"] == pytest.approx(computed["east_m"], abs=1e-9)
        assert written["north_m"] == pytest.approx(computed["north_m"], abs=1e-9)


def test_the_vectors_cover_the_site_in_every_direction_and_across_the_antimeridian() -> None:
    names = [case["name"] for case in GOLDEN["cases"]]
    assert {name.split(":")[0] for name in names} == {
        "farm", "equator", "arctic", "south", "antimeridian",
    }  # fmt: skip
    crossing = [
        case
        for case in GOLDEN["cases"]
        if case["origin"]["longitude_deg"] > 0 > case["point"]["longitude_deg"]
    ]
    assert crossing, "no vector crosses the antimeridian"
    farthest = max(math.hypot(case["east_m"], case["north_m"]) for case in GOLDEN["cases"])
    assert farthest == pytest.approx(2500, abs=5)


def test_the_origin_is_the_frame_s_zero_and_east_is_east() -> None:
    farm = Geodetic(41.6523, -4.7245)
    assert east_north(farm, farm) == EastNorth(0.0, 0.0)
    eastward = east_north(farm, Geodetic(41.6523, -4.7235))
    assert eastward.east_m > 0 and abs(eastward.north_m) < 0.01
