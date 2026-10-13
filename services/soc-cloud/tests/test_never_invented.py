"""SOC never fills a missing measurement (FR-SAF-03).

From Sky Orchestrator's OSD to the browsers' sample, a value the message lacks stays
None. The code is searched for any way to put something in its place: a default
other than None on a field the wire may omit, an `or`, a `.get` with a default, a
conditional falling back to a value. Then an OSD without any measurement is mapped
and broadcast, and every measurement comes out None.
"""

from __future__ import annotations

import ast
from pathlib import Path

import msgspec
import pytest

from soc_cloud import fanout, flights
from soc_cloud.link import messages, progress, telemetry
from soc_cloud.link.messages import AircraftOsd, Battery, PositionState

#: The code a measurement passes through, from the wire to the broadcast: each module
#: whole, or the one function of it that handles measurements.
MAPPING = [
    (Path(messages.__file__), None),
    (Path(telemetry.__file__), None),
    (Path(progress.__file__), None),
    (Path(fanout.__file__), "payload"),
    (Path(flights.__file__), "_keep_in_track"),
]
#: Every measurement the broadcast carries; the rest identify and time the sample.
MEASUREMENTS = (
    "latitude_deg",
    "longitude_deg",
    "height_m",
    "heading_deg",
    "home_distance_m",
    "battery_pct",
    "satellites",
    "gps_quality",
    "mode_code",
)


def scope(source: str, function: str | None) -> ast.AST:
    tree = ast.parse(source)
    if function is None:
        return tree
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function:
            return node
    raise AssertionError(f"no function {function}")


def fallbacks(source: str, function: str | None = None) -> list[str]:
    """Each expression in `source` that could stand in for a missing value, by line."""
    found: list[str] = []
    for node in ast.walk(scope(source, function)):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.Or):
            found.append(f"{line}: `or`")
        if isinstance(node, ast.IfExp) and not (
            isinstance(node.orelse, ast.Constant) and node.orelse.value is None
        ):
            found.append(f"{line}: a conditional falling back to something other than None")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"get", "setdefault", "pop"}
            and len(node.args) + len(node.keywords) > 1
        ):
            found.append(f"{line}: `.{node.func.attr}` with a default")
    return found


@pytest.mark.parametrize(
    ("path", "function"), MAPPING, ids=lambda part: getattr(part, "name", part)
)
def test_the_mapping_has_no_way_to_fill_a_missing_value(path: Path, function: str | None) -> None:
    assert fallbacks(path.read_text(encoding="utf-8"), function) == []


def test_the_search_finds_each_way_to_fill_a_missing_value() -> None:
    planted = (
        "height = osd.elevation or 0\n"
        "battery = osd.battery.capacity_percent if osd.battery else 100\n"
        "mode = row.get('mode_code', 0)\n"
        "kept = osd.battery.capacity_percent if osd.battery else None\n"
    )
    assert fallbacks(planted) == [
        "1: `or`",
        "2: a conditional falling back to something other than None",
        "3: `.get` with a default",
    ]


@pytest.mark.parametrize("struct", [AircraftOsd, Battery, PositionState])
def test_a_field_the_wire_may_omit_defaults_to_none(struct: type[msgspec.Struct]) -> None:
    defaults = {field.name: field.default for field in msgspec.structs.fields(struct)}
    assert defaults == dict.fromkeys(defaults, None)


def test_an_osd_without_measurements_is_broadcast_without_them() -> None:
    bare = msgspec.json.decode(b"{}", type=AircraftOsd)
    hollow = msgspec.json.decode(b'{"battery": {}, "position_state": {}}', type=AircraftOsd)
    for osd in (bare, hollow):
        sample = telemetry.sample("lab", "SOTESTDOCK01", "SOTESTUAV001", 1_000, osd)
        broadcast = fanout.payload(sample, sent_at_ms=1_004)
        assert {name: broadcast[name] for name in MEASUREMENTS} == dict.fromkeys(MEASUREMENTS)
