"""The wayline's design and bake, contracts/geometry/design.schema.json (FR-WAY-07)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest

from soc_geo.projection import Geodetic
from soc_geo.sphere import distance_m

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA = jsonschema_rs.validator_for(
    json.loads((CONTRACTS / "geometry" / "design.schema.json").read_text(encoding="utf-8"))
)
MISSION_PLAN = jsonschema_rs.validator_for(
    json.loads(
        (CONTRACTS / "sky-orchestrator" / "msdk" / "mission-plan.schema.json").read_text(
            encoding="utf-8"
        )
    )
)
EXAMPLES = sorted((CONTRACTS / "geometry" / "examples").glob("design.*.json"))
#: What the bake reports beside the plan, which Sky Orchestrator's plan does not hold.
SOC_ONLY = ("distance_m", "duration_s", "violations")


def example(path: Path) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.name)
def test_every_example_follows_the_schema(path: Path) -> None:
    assert list(SCHEMA.iter_errors(example(path))) == []


def as_sky_orchestrators(position: list[float]) -> dict[str, float]:
    """A stored position in Sky Orchestrator's form, as the flight file builder writes it."""
    longitude, latitude = position
    return {"latitude_deg": latitude, "longitude_deg": longitude}


def test_a_bake_is_sky_orchestrators_plan_once_its_file_names_it() -> None:
    baked = example(CONTRACTS / "geometry" / "examples" / "design.route.json")["baked"]
    plan = {key: value for key, value in baked.items() if key not in SOC_ONLY}
    plan["reference_point"] = as_sky_orchestrators(baked["reference_point"])
    plan["waypoints"] = [
        {"index": w["index"], **as_sky_orchestrators(w["position"]), "height_m": w["height_m"]}
        for w in baked["waypoints"]
    ]
    plan.update(
        wayline_id="3f2b8c1e-6a4d-4e2f-9b1a-7c5d3e8f0a12",
        fingerprint_md5="0123456789abcdef0123456789abcdef",
    )
    assert list(MISSION_PLAN.iter_errors(plan)) == []


def test_positions_are_stored_in_geojson_order() -> None:
    design = example(CONTRACTS / "geometry" / "examples" / "design.route.json")["design"]
    longitude, latitude = design["takeoff"]
    assert (longitude, latitude) == (-4.7245, 41.6523)
    swapped = example(CONTRACTS / "geometry" / "examples" / "design.route.json")
    swapped["design"]["takeoff"] = [41.6523, 181.0]
    assert list(SCHEMA.iter_errors(swapped)) != []


def test_a_bakes_distance_is_measured_in_sky_orchestrators_metric() -> None:
    baked = example(CONTRACTS / "geometry" / "examples" / "design.route.json")["baked"]
    longitude, latitude = baked["reference_point"]
    previous = Geodetic(latitude, longitude)
    total = 0.0
    for waypoint in baked["waypoints"]:
        longitude, latitude = waypoint["position"]
        here = Geodetic(latitude, longitude)
        total += distance_m(previous, here)
        previous = here
    assert baked["distance_m"] == pytest.approx(total, abs=1e-6)
    assert baked["duration_s"] == pytest.approx(total / baked["speed_ms"], abs=1e-3)


@pytest.mark.parametrize(
    ("change", "path"),
    [
        (lambda d: d["design"].update(speed_ms=0), "/design/speed_ms"),
        (lambda d: d["design"]["primitives"][0]["points"].clear(), "/design/primitives/0"),
        (lambda d: d["design"].update(finish_action="crash"), "/design/finish_action"),
        (lambda d: d["baked"]["waypoints"][0].update(height_m=-1), "/baked"),
        (lambda d: d["design"]["primitives"].append({"kind": "spiral"}), "/design/primitives/2"),
    ],
)
def test_a_design_off_the_schema_is_refused_where_it_is_off(change: Any, path: str) -> None:
    broken = example(CONTRACTS / "geometry" / "examples" / "design.route.json")
    change(broken)
    errors = list(SCHEMA.iter_errors(broken))
    assert errors != []
    paths = ["/" + "/".join(str(part) for part in error.instance_path) for error in errors]
    # A oneOf names the alternative's container; a plain keyword, the value itself.
    assert any(found.startswith(path) or path.startswith(found) for found in paths), paths
