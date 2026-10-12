"""SO's metric, held to SO's own geodesy cases (ADR-0009)."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from soc_geo.projection import Geodetic
from soc_geo.sphere import EARTH_RADIUS_M, distance_m

CASES_FILE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "sky-orchestrator"
    / "msdk"
    / "geodesy-cases.json"
)
CASES: dict[str, Any] = json.loads(CASES_FILE.read_text(encoding="utf-8"))


def geodetic(value: dict[str, float]) -> Geodetic:
    return Geodetic(value["latitude_deg"], value["longitude_deg"])


def test_it_is_sos_sphere() -> None:
    assert EARTH_RADIUS_M == 6_371_008.8
    assert CASES["tolerance_m"] == 1e-06


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda case: case["what"])
def test_every_case_of_sky_orchestrator_within_its_tolerance(case: dict[str, Any]) -> None:
    measured = distance_m(geodetic(case["a"]), geodetic(case["b"]))
    assert measured == pytest.approx(case["distance_m"], abs=CASES["tolerance_m"])


def test_it_measures_both_ways_and_across_the_antimeridian() -> None:
    east = Geodetic(10.0, 179.9999)
    west = Geodetic(10.0, -179.9999)
    assert distance_m(east, west) == distance_m(west, east)
    assert distance_m(east, west) < 25.0


@pytest.mark.parametrize(
    "point",
    [Geodetic(math.nan, 0.0), Geodetic(0.0, math.inf), Geodetic(90.5, 0.0), Geodetic(0.0, -181.0)],
)
def test_a_point_that_cannot_be_a_position_is_refused_never_measured(point: Geodetic) -> None:
    with pytest.raises(ValueError, match="out of range"):
        distance_m(Geodetic(0.0, 0.0), point)
