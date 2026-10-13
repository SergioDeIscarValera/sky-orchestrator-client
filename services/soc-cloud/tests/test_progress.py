"""flighttask_progress decoded as sent, a missing field None, a malformed message refused."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import msgspec
import pytest

from soc_cloud.link.progress import (
    PROGRESS,
    BreakPoint,
    FlightProgress,
    FlightStatus,
    decode_progress,
)
from soc_cloud.wire import MQTT, WireContract

REQUIREMENTS = Path(__file__).resolve().parents[3] / "docs" / "requirements"
CONTRACT = WireContract()
KIND = "events/flighttask_progress"
EXAMPLE = MQTT / "examples" / "events.flighttask_progress.json"
FLIGHT = "flight-0001"
DOCK = "SOTESTDOCK01"
TID = "00000000-0000-4000-8000-000000000011"


def message(
    *,
    status: str = "in_progress",
    result: int = 0,
    percent: int = 0,
    index: int = 0,
    break_point: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A flighttask_progress shaped as the vendored schema shapes it, with these values."""
    ext: dict[str, Any] = {
        "current_waypoint_index": index,
        "media_count": 0,
        "flight_id": FLIGHT,
        "wayline_mission_state": 4,
        "wayline_id": 0,
    }
    if break_point is not None:
        ext["break_point"] = break_point
    return {
        "tid": TID,
        "bid": FLIGHT,
        "timestamp": 1790800000000,
        "gateway": DOCK,
        "method": PROGRESS,
        "need_reply": 0,
        "data": {
            "result": result,
            "output": {
                "ext": ext,
                "progress": {"current_step": 20, "percent": percent},
                "status": status,
            },
        },
    }


def paused_at(reason: int) -> dict[str, Any]:
    return {"index": 3, "state": 1, "progress": 0.42, "wayline_id": 0, "break_reason": reason}


def raw(payload: Any) -> bytes:
    return json.dumps(payload).encode()


def at(payload: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    """The dict that holds the last key of `path`."""
    node = payload
    for key in path[:-1]:
        node = node[key]
    return node


def requirement_values(file: str, section: str, attribute: str) -> list[str]:
    """The backticked values of one attribute row in a section of a requirements file."""
    text = (REQUIREMENTS / file).read_text(encoding="utf-8")
    body = text.split(section, 1)[1].split("\n## ", 1)[0]
    row = next(line for line in body.splitlines() if line.startswith(f"| `{attribute}` |"))
    return re.findall(r"`([a-z_]+)`", row.split("|")[3])


def test_the_message_builder_is_valid_under_the_vendored_schema() -> None:
    assert CONTRACT.problems(KIND, message()) == []
    assert CONTRACT.problems(KIND, message(status="paused", break_point=paused_at(514))) == []


def test_the_vendored_example_decodes_as_sent() -> None:
    assert decode_progress(EXAMPLE.read_bytes()) == FlightProgress(
        bid=FLIGHT,
        timestamp=1790800000000,
        gateway=DOCK,
        flight_id=FLIGHT,
        status=FlightStatus.IN_PROGRESS,
        result=0,
        percent=0,
        current_waypoint_index=0,
        media_count=0,
    )


@pytest.mark.parametrize("status", list(FlightStatus), ids=str)
def test_each_status_decodes_to_its_dji_value(status: FlightStatus) -> None:
    assert decode_progress(raw(message(status=status))).status is status


def test_flight_status_is_exactly_irst_status() -> None:
    documented = requirement_values("information-requirements.md", "## IR-FST ", "status")
    assert sorted(status.value for status in FlightStatus) == sorted(documented)


def test_a_break_point_decodes_with_its_reason_and_the_rest_as_sent() -> None:
    progress = decode_progress(
        raw(message(status="paused", break_point={**paused_at(514), "attitude_head": -90.5}))
    )
    assert progress.break_point == BreakPoint(
        index=3,
        state=1,
        progress=0.42,
        wayline_id=0,
        break_reason=514,
        attitude_head=-90.5,
    )
    assert progress.status is FlightStatus.PAUSED


def test_a_flight_without_a_break_point_has_none() -> None:
    assert decode_progress(raw(message())).break_point is None


@pytest.mark.parametrize(("percent", "index"), [(0, 0), (37, 4), (100, 1234)])
def test_percent_and_waypoint_index_are_carried_as_sent(percent: int, index: int) -> None:
    progress = decode_progress(raw(message(percent=percent, index=index)))
    assert (progress.percent, progress.current_waypoint_index) == (percent, index)


FIELD_OF_PATH = {
    ("bid",): "bid",
    ("timestamp",): "timestamp",
    ("gateway",): "gateway",
    ("data", "result"): "result",
    ("data", "output", "status"): "status",
    ("data", "output", "progress", "percent"): "percent",
    ("data", "output", "ext", "current_waypoint_index"): "current_waypoint_index",
    ("data", "output", "ext", "media_count"): "media_count",
    ("data", "output", "ext", "flight_id"): "flight_id",
    ("data", "output", "ext", "break_point"): "break_point",
}


@pytest.mark.parametrize("path", list(FIELD_OF_PATH), ids=lambda path: "/".join(path))
def test_a_field_the_message_lacks_is_none_and_nothing_else_changes(path: tuple[str, ...]) -> None:
    field = FIELD_OF_PATH[path]
    complete = decode_progress(raw(message(break_point=paused_at(514))))
    lacking = message(break_point=paused_at(514))
    del at(lacking, path)[path[-1]]
    decoded = decode_progress(raw(lacking))
    assert getattr(decoded, field) is None
    assert decoded == msgspec.structs.replace(complete, **{field: None})


def test_a_missing_output_leaves_its_fields_none() -> None:
    lacking = message()
    del lacking["data"]["output"]
    assert decode_progress(raw(lacking)) == FlightProgress(
        bid=FLIGHT, timestamp=1790800000000, gateway=DOCK, result=0
    )


def test_a_message_with_only_its_method_decodes_to_nothing() -> None:
    assert decode_progress(raw({"method": PROGRESS})) == FlightProgress()


def test_bytes_that_are_not_json_raise_naming_the_message() -> None:
    with pytest.raises(ValueError, match=f"malformed {PROGRESS} message"):
        decode_progress(b"{not json")


@pytest.mark.parametrize(
    ("path", "value", "location"),
    [
        (("data", "result"), "0", "$.data.result"),
        (("data", "output", "progress", "percent"), 37.5, "$.data.output.progress.percent"),
        (
            ("data", "output", "ext", "current_waypoint_index"),
            "4",
            "$.data.output.ext.current_waypoint_index",
        ),
        (("data", "output", "status"), "bogus", "$.data.output.status"),
        (("bid",), 7, "$.bid"),
    ],
)
def test_a_field_of_the_wrong_type_raises_naming_where_it_is(
    path: tuple[str, ...], value: Any, location: str
) -> None:
    payload = message()
    at(payload, path)[path[-1]] = value
    with pytest.raises(ValueError, match=re.escape(location)):
        decode_progress(raw(payload))


def test_another_event_is_refused_by_name() -> None:
    with pytest.raises(ValueError, match="not a flighttask_progress message: method is 'x'"):
        decode_progress(raw({**message(), "method": "x"}))


def test_a_message_without_a_method_is_refused() -> None:
    with pytest.raises(ValueError, match="method is None"):
        decode_progress(raw({"data": {}}))
