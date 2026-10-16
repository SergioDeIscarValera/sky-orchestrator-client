"""Hold SOC's flight files to Sky Orchestrator's own ingest (FR-WAY-11, FR-WAY-08, NFR-COMP-02).

Builds every golden case of contracts/flight-files with soc_operations.flight_files, runs
so-wayline's own ``ingest.validate`` on each KMZ under three envelopes, and compares what it
refuses, rule by rule and waypoint by waypoint, with what soc_geo.limits predicts for the same
flight. Sky Orchestrator's code is read from its checkout and run in its own interpreter; nothing
of its stack is touched.

Passes when every golden file is VALID under the permissive envelope and SO's refusals equal
SOC's prediction under every envelope. Run from the repository root:

    uv run --frozen python -m soc_operations.so_acceptance \\
        --so-root ../sky-orchestrator --so-python /path/to/python-with-lxml-and-jsonschema-rs

A developer's check, not the service's: it reads the golden cases from the repository.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from soc_geo.limits import Envelope, plan_of, violations
from soc_geo.projection import Geodetic
from soc_operations import flight_files

GOLDEN = Path(__file__).resolve().parents[4] / "contracts" / "flight-files"

# The names the golden cases are built with, as the flight file tests build them.
CASES = {"route-return-home": "Route return home", "six-waypoints-land": "Six waypoints land"}

# A permissive envelope every reference file must pass, Sky Orchestrator's defaults, and one
# tight enough to break every rule the golden cases can break.
ENVELOPES: dict[str, dict[str, float]] = {
    "permissive": {
        "max_height_m": 120,
        "geofence_radius_m": 500,
        "max_home_distance_m": 500,
        "max_leg_m": 1000,
        "max_transit_m": 1000,
        "max_total_distance_m": 10000,
        "max_waypoints": 200,
        "max_horizontal_speed_ms": 15,
    },
    "so_defaults": {
        "max_height_m": 30,
        "geofence_radius_m": 50,
        "max_home_distance_m": 50,
        "max_leg_m": 100,
        "max_transit_m": 300,
        "max_total_distance_m": 1000,
        "max_waypoints": 20,
        "max_horizontal_speed_ms": 3.0,
    },
    "tight": {
        "max_height_m": 32,
        "geofence_radius_m": 25,
        "max_home_distance_m": 30,
        "max_leg_m": 20,
        "max_transit_m": 10,
        "max_total_distance_m": 80,
        "max_waypoints": 3,
        "max_horizontal_speed_ms": 5.0,
    },
}

# Run by Sky Orchestrator's interpreter, with only its own sources on the path.
SO_SIDE = """
import json, sys, uuid
from pathlib import Path
so_root, work = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(so_root / "services/so-wayline/src"), str(so_root / "libs/so-config/src")]
from so_wayline import ingest
from so_wayline.config import WaylineConfig
from so_wayline.geodesy import GeoPoint
jobs = json.loads((work / "jobs.json").read_text())
answers = {}
for job in jobs:
    longitude, latitude = job["centre"]
    config = WaylineConfig(
        geofence_center=GeoPoint(latitude_deg=latitude, longitude_deg=longitude),
        max_kmz_bytes=10485760, presign_ttl_s=300, cloud_role="primary",
        fingerprint="soc-acceptance", **job["envelope"])
    kmz = (work / job["kmz"]).read_bytes()
    outcome = ingest.validate(kmz, config, wayline_id=str(uuid.uuid4()))
    answers[job["key"]] = outcome.report_json()
print(json.dumps(answers))
"""

Finding = tuple[str, int | None]


def envelope_of(centre: Geodetic, limits: dict[str, float]) -> Envelope:
    """soc_geo's envelope for one of the envelopes above, round `centre`."""
    return Envelope(
        geofence_center=centre,
        geofence_radius_m=limits["geofence_radius_m"],
        max_height_m=limits["max_height_m"],
        max_home_distance_m=limits["max_home_distance_m"],
        max_leg_m=limits["max_leg_m"],
        max_transit_m=limits["max_transit_m"],
        max_total_distance_m=limits["max_total_distance_m"],
        max_waypoints=int(limits["max_waypoints"]),
        max_horizontal_speed_ms=limits["max_horizontal_speed_ms"],
    )


def findings_of(problems: list[dict[str, Any]]) -> list[Finding]:
    """SO's problems as (rule, waypoint) pairs, in a stable order."""
    pairs = {(str(problem["code"]), problem.get("waypoint_index")) for problem in problems}
    return sorted(pairs, key=lambda pair: (pair[0], -1 if pair[1] is None else pair[1]))


def verdict(key: str, status: str, predicted: list[Finding], actual: list[Finding]) -> str | None:
    """Why a case fails acceptance, or None when it passes."""
    if key.endswith("/permissive") and status != "VALID":
        return f"{key}: a reference file is {status} under the permissive envelope: {actual}"
    if predicted != actual:
        return f"{key}: SOC predicts {predicted}, SO finds {actual}"
    return None


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--so-root", type=Path, required=True)
    parser.add_argument("--so-python", type=Path, required=True)
    parser.add_argument("--golden", type=Path, default=GOLDEN)
    options = parser.parse_args(arguments)
    golden: Path = options.golden

    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        jobs: list[dict[str, Any]] = []
        predictions: dict[str, list[Finding]] = {}
        for case, name in CASES.items():
            flight = json.loads((golden / case / "flight.json").read_text(encoding="utf-8"))
            (work / f"{case}.kmz").write_bytes(flight_files.build(flight, name=name))
            longitude, latitude = flight["reference_point"]
            for envelope_name, limits in ENVELOPES.items():
                key = f"{case}/{envelope_name}"
                centre = Geodetic(latitude_deg=latitude, longitude_deg=longitude)
                found = violations(
                    plan_of(flight),
                    envelope_of(centre, limits),
                    transitional_speed_ms=flight["speed_ms"],
                )
                predictions[key] = sorted(
                    {(v.rule, v.waypoint_index) for v in found},
                    key=lambda pair: (pair[0], -1 if pair[1] is None else pair[1]),
                )
                jobs.append(
                    {
                        "key": key,
                        "kmz": f"{case}.kmz",
                        "centre": [longitude, latitude],
                        "envelope": limits,
                    }
                )
        (work / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
        (work / "so_side.py").write_text(SO_SIDE, encoding="utf-8")
        # The interpreter is the developer's own, named on the command line.
        ran = subprocess.run(  # noqa: S603
            [
                str(options.so_python),
                "-I",
                str(work / "so_side.py"),
                str(options.so_root),
                str(work),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if ran.returncode != 0:
            print(ran.stderr, file=sys.stderr)
            return 2
        answers = json.loads(ran.stdout)

    failures: list[str] = []
    for key, predicted in predictions.items():
        status = answers[key]["status"]
        actual = findings_of(answers[key]["problems"])
        failure = verdict(key, status, predicted, actual)
        failures += [] if failure is None else [failure]
        print(f"{key:34} SO {status:9} {'agrees' if failure is None else 'DIFFERS'} {actual}")
    for failure in failures:
        print(failure, file=sys.stderr)
    print("Sky Orchestrator agrees with SOC on every case." if not failures else "Disagreement.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
