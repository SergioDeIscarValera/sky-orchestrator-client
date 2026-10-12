"""contracts/geometry/circle.json is what its oracle writes today (FR-WAY-04, ADR-0009)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "geometry" / "circle.json"


def test_the_circle_vectors_are_what_the_oracle_writes_today() -> None:
    spec = importlib.util.spec_from_file_location(
        "circle_oracle", Path(__file__).with_name("circle_oracle.py")
    )
    assert spec is not None and spec.loader is not None
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    fresh: dict[str, Any] = oracle.vectors()
    assert fresh == json.loads(VECTORS.read_text(encoding="utf-8"))
