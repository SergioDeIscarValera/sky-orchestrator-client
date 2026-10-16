"""The check of SOC's flight files against Sky Orchestrator's own ingest (NFR-COMP-02).

Sky Orchestrator's checkout is replaced by a reduced one whose ingest answers each KMZ by
a rule given per test, so the runner, the comparison and the verdict are held here without
it; the real run is `python -m soc_operations.so_acceptance` against its checkout.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from soc_operations import so_acceptance

FAKE_SO = {
    "services/so-wayline/src/so_wayline/__init__.py": "",
    "services/so-wayline/src/so_wayline/geodesy.py": (
        "from dataclasses import dataclass\n"
        "@dataclass(frozen=True)\n"
        "class GeoPoint:\n"
        "    latitude_deg: float\n"
        "    longitude_deg: float\n"
    ),
    "services/so-wayline/src/so_wayline/config.py": (
        "class WaylineConfig:\n"
        "    def __init__(self, **values):\n"
        "        self.__dict__.update(values)\n"
    ),
    "libs/so-config/src/so_config/__init__.py": "",
}

# An ingest that accepts everything, as Sky Orchestrator does a clean file in a wide envelope.
ACCEPTS_ALL = (
    "class Outcome:\n"
    "    def __init__(self, status, problems):\n"
    "        self.status, self.problems = status, problems\n"
    "    def report_json(self):\n"
    "        return {'status': self.status, 'checks': [], 'problems': self.problems}\n"
    "def validate(data, config, *, wayline_id):\n"
    "    return Outcome('VALID', [])\n"
)

# An ingest that refuses every file a height, telling back what it was configured with.
REFUSES_HEIGHT = (
    "class Outcome:\n"
    "    def __init__(self, status, problems):\n"
    "        self.status, self.problems = status, problems\n"
    "    def report_json(self):\n"
    "        return {'status': self.status, 'checks': [], 'problems': self.problems}\n"
    "def validate(data, config, *, wayline_id):\n"
    "    centre = config.geofence_center\n"
    "    return Outcome('REJECTED', [{'code': 'height_above_max', 'waypoint_index': 2,\n"
    "        'limit': config.max_height_m, 'lat': centre.latitude_deg, 'size': len(data)}])\n"
)


def checkout(root: Path, ingest: str) -> Path:
    for path, text in {**FAKE_SO, "services/so-wayline/src/so_wayline/ingest.py": ingest}.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text, encoding="utf-8")
    return root


def test_findings_pair_each_rule_with_its_waypoint_once_in_a_stable_order() -> None:
    problems: list[dict[str, object]] = [
        {"code": "leg_too_long", "waypoint_index": 3},
        {"code": "too_many_waypoints"},
        {"code": "leg_too_long", "waypoint_index": 1},
        {"code": "leg_too_long", "waypoint_index": 3},
        {"code": "speed_above_max", "waypoint_index": 1},
        {"code": "speed_above_max"},
    ]
    assert so_acceptance.findings_of(problems) == [
        ("leg_too_long", 1),
        ("leg_too_long", 3),
        ("speed_above_max", None),
        ("speed_above_max", 1),
        ("too_many_waypoints", None),
    ]


def test_agreement_passes() -> None:
    found: list[tuple[str, int | None]] = [("height_above_max", 2)]
    assert so_acceptance.verdict("route/tight", "REJECTED", found, found) is None
    assert so_acceptance.verdict("route/permissive", "VALID", [], []) is None


def test_a_reference_file_refused_under_the_permissive_envelope_fails() -> None:
    failure = so_acceptance.verdict("route/permissive", "REJECTED", [], [])
    assert failure is not None
    assert "REJECTED under the permissive envelope" in failure


@pytest.mark.parametrize("actual", [[("height_above_max", 3)], [], [("leg_too_long", 2)]])
def test_a_rule_or_a_waypoint_told_apart_fails(actual: list[tuple[str, int | None]]) -> None:
    predicted: list[tuple[str, int | None]] = [("height_above_max", 2)]
    assert so_acceptance.verdict("route/tight", "REJECTED", predicted, actual) is not None


def test_the_runner_answers_each_job_with_the_report_its_envelope_gave(tmp_path: Path) -> None:
    root = checkout(tmp_path / "so", REFUSES_HEIGHT)
    work = tmp_path / "work"
    work.mkdir()
    (work / "a.kmz").write_bytes(b"abc")
    jobs = [
        {"key": "a", "kmz": "a.kmz", "centre": [-4.72, 41.65], "envelope": {"max_height_m": 25}}
    ]
    (work / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
    (work / "so_side.py").write_text(so_acceptance.SO_SIDE, encoding="utf-8")
    ran = subprocess.run(  # noqa: S603 - this interpreter, on a script the test wrote
        [sys.executable, "-I", str(work / "so_side.py"), str(root), str(work)],
        capture_output=True,
        text=True,
        check=True,
    )
    (problem,) = json.loads(ran.stdout)["a"]["problems"]
    # The envelope reached SO's configuration, the centre went in latitude first, and the
    # KMZ went in whole.
    assert problem == {
        "code": "height_above_max",
        "waypoint_index": 2,
        "limit": 25,
        "lat": 41.65,
        "size": 3,
    }


def test_sky_orchestrator_refusing_what_soc_did_not_predict_fails(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = checkout(tmp_path, REFUSES_HEIGHT)
    assert so_acceptance.main(["--so-root", str(root), "--so-python", sys.executable]) == 1
    assert "route-return-home/permissive: a reference file is REJECTED" in capsys.readouterr().err


def test_sky_orchestrator_accepting_what_soc_refuses_fails(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = checkout(tmp_path, ACCEPTS_ALL)
    assert so_acceptance.main(["--so-root", str(root), "--so-python", sys.executable]) == 1
    told = capsys.readouterr().err
    assert "route-return-home/so_defaults: SOC predicts [('height_above_max', 3)" in told
    assert "route-return-home/permissive" not in told


def test_sky_orchestrator_failing_to_run_is_told_apart(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert so_acceptance.main(["--so-root", str(tmp_path), "--so-python", sys.executable]) == 2
    assert "ModuleNotFoundError" in capsys.readouterr().err
