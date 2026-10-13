"""What the operator is told when Sky Orchestrator refuses a command (FR-OPS-09, FR-CMD-06).

The meanings are contracts/results/results.json's, by the method that drew the code: the
same code means different things on a prepare and on an execute (Sky Orchestrator's
ADR-0037). 316010 on an execute is told apart by the stack's status, read when the reply
came.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

CONTRACT = Path(__file__).resolve().parents[4] / "contracts" / "results" / "results.json"

#: The DJI method of each wire verb (soc-cloud's SERVICE_METHODS).
METHODS = {
    "prepare": "flighttask_prepare",
    "execute": "flighttask_execute",
    "pause": "flighttask_pause",
    "recovery": "flighttask_recovery",
    "return_home": "return_home",
    "undo": "flighttask_undo",
}


def _load() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return loaded


_RESULTS = _load()


def meaning(verb: str, result: int, status: Mapping[str, Any] | None) -> str:
    """The words for `result` on `verb`, judged on the stack's `status` where they depend on it."""
    entry = _RESULTS["results"].get(METHODS.get(verb, verb), {}).get(str(result))
    if entry is None:
        return f"{_RESULTS['default']} ({result})"
    if isinstance(entry, str):
        return entry
    condition = _condition(status)
    for case in entry["by_status"]:
        if case["when"] == condition:
            return str(case["meaning"])
    return str(entry["otherwise"])


def _condition(status: Mapping[str, Any] | None) -> str | None:
    """Which of 316010's causes the stack's status shows (dependencies, SO #126)."""
    if status is None:
        return None
    if (status.get("link") or {}).get("state") == "down":
        return "link_down"
    mode, active = status.get("simulator_mode"), status.get("simulator_active")
    if mode is False and active is True:
        return "real_mode_simulator_active"
    if mode is True and active is False:
        return "simulator_mode_simulator_inactive"
    return None
