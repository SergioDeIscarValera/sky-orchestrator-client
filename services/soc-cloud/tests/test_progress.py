"""flighttask_progress decoded as sent, a missing field None, a malformed message refused."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import msgspec
import pytest

from soc_cloud.link.progress import (
    BREAK_REASONS,
    END_RESULTS,
    PROGRESS,
    TERMINAL,
    BreakPoint,
    EndReason,
    FlightProgress,
    FlightStatus,
    decode_progress,
    end_reason,
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


def ended(**changes: Any) -> EndReason | None:
    return end_reason(decode_progress(raw(message(**changes))))


END_RESULT_CASES = [
    pytest.param(321514, EndReason.ENVELOPE_BREACH, id="321514"),
    pytest.param(321773, EndReason.LOW_BATTERY, id="321773"),
    pytest.param(321775, EndReason.LINK_LOST, id="321775"),
    pytest.param(322282, EndReason.PILOT_TAKEOVER, id="322282"),
    pytest.param(322283, EndReason.OPERATOR_RETURN, id="322283"),
    pytest.param(321000, None, id="321000"),
]


@pytest.mark.parametrize("status", sorted(TERMINAL), ids=str)
@pytest.mark.parametrize(("code", "reason"), END_RESULT_CASES)
def test_each_sky_orchestrator_end_result_maps_to_its_end_reason(
    code: int, reason: EndReason | None, status: FlightStatus
) -> None:
    assert ended(status=status, result=code) is reason


def test_ok_with_result_zero_is_completed() -> None:
    assert ended(status="ok", result=0) is EndReason.COMPLETED


def test_a_canceled_task_is_cancelled() -> None:
    assert ended(status="canceled", result=0) is EndReason.CANCELLED


@pytest.mark.parametrize("status", sorted(set(FlightStatus) - TERMINAL), ids=str)
@pytest.mark.parametrize("result", [0, 322283, 321514])
def test_a_status_that_does_not_end_the_task_gives_no_end_reason(
    status: FlightStatus, result: int
) -> None:
    assert ended(status=status, result=result) is None


def test_a_missing_status_ends_nothing_whatever_the_result() -> None:
    lacking = message(result=322283)
    del lacking["data"]["output"]["status"]
    assert end_reason(decode_progress(raw(lacking))) is None


def test_a_missing_result_is_not_completed() -> None:
    lacking = message(status="ok")
    del lacking["data"]["result"]
    assert end_reason(decode_progress(raw(lacking))) is None


@pytest.mark.parametrize("status", ["failed", "rejected", "timeout", "partially_done"])
def test_a_terminal_status_with_no_known_code_or_reason_gives_none(status: str) -> None:
    assert ended(status=status, result=999_999) is None


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        pytest.param(514, EndReason.ENVELOPE_BREACH, id="514"),
        pytest.param(773, EndReason.LOW_BATTERY, id="773"),
        pytest.param(775, EndReason.LINK_LOST, id="775"),
        pytest.param(1282, EndReason.PILOT_TAKEOVER, id="1282"),
        pytest.param(2, EndReason.AIRCRAFT_FAULT, id="2"),
    ],
)
def test_a_stop_on_the_aircraft_own_takes_the_end_reason_of_its_break_reason(
    reason: int, expected: EndReason
) -> None:
    assert ended(status="failed", result=999_999, break_point=paused_at(reason)) is expected


@pytest.mark.parametrize("reason", [0, 1564, 65534], ids=str)
def test_break_reasons_with_no_ir_ops_value_end_nothing(reason: int) -> None:
    assert ended(status="failed", result=999_999, break_point=paused_at(reason)) is None


def test_a_flight_that_finished_ok_after_a_stop_is_completed() -> None:
    # The break point is kept until the mission resumes (FR-FLT-12), so a resumed flight
    # that finishes ok still carries the reason it stopped for.
    assert ended(status="ok", result=0, break_point=paused_at(514)) is EndReason.COMPLETED


def test_an_ok_task_is_never_given_a_break_reason() -> None:
    # The break point of an earlier stop is kept until the mission resumes, so an ok task that
    # did not finish with result 0 names no end reason rather than that stop.
    assert ended(status="ok", result=999_999, break_point=paused_at(514)) is None


def test_a_canceled_task_that_stopped_on_its_own_takes_the_break_reason() -> None:
    # A break point means the mission flew and stopped on its own, so a cancel after it is
    # not the cancel of FR-CMD-05, which is for a task that never flew.
    assert ended(status="canceled", result=0, break_point=paused_at(514)) is (
        EndReason.ENVELOPE_BREACH
    )


def test_a_return_home_after_a_stop_is_the_operators_return_by_its_code() -> None:
    # The break point of the earlier stop is kept through the return and the landing; the
    # result code is the more specific reading of how the task ended.
    assert ended(status="canceled", result=322283, break_point=paused_at(514)) is (
        EndReason.OPERATOR_RETURN
    )


def test_terminal_statuses_are_the_six_that_end_a_task() -> None:
    ending = {
        FlightStatus.OK,
        FlightStatus.FAILED,
        FlightStatus.CANCELED,
        FlightStatus.REJECTED,
        FlightStatus.TIMEOUT,
        FlightStatus.PARTIALLY_DONE,
    }
    running = {FlightStatus.SENT, FlightStatus.IN_PROGRESS, FlightStatus.PAUSED}
    assert ending == TERMINAL
    assert set(FlightStatus) - TERMINAL == running


def test_end_reason_is_exactly_irops_end_reason() -> None:
    documented = requirement_values("information-requirements.md", "## IR-OPS ", "end_reason")
    assert [reason.value for reason in EndReason] == documented


def test_the_end_result_table_holds_each_code_of_the_acceptance() -> None:
    text = (REQUIREMENTS / "functional-requirements.md").read_text(encoding="utf-8")
    listed = re.search(r"end results \(([\d,\s]+)\)", text)
    assert listed is not None
    assert set(END_RESULTS) == {int(code) for code in re.findall(r"\d+", listed.group(1))}


def test_return_home_is_documented_as_322283() -> None:
    text = (REQUIREMENTS / "functional-requirements.md").read_text(encoding="utf-8")
    assert re.search(r"operator's return as its end\s+reason \(`322283`\)", text)


DOCUMENTED_BREAK_REASONS = [
    (514, "an envelope breach", EndReason.ENVELOPE_BREACH),
    (773, "low battery", EndReason.LOW_BATTERY),
    (775, "a lost link", EndReason.LINK_LOST),
    (1282, "a pilot takeover", EndReason.PILOT_TAKEOVER),
    (2, "an aircraft fault", EndReason.AIRCRAFT_FAULT),
]


def test_the_break_reason_table_matches_the_words_of_the_vendored_schema() -> None:
    schema = (MQTT / "events" / "flighttask_progress.schema.json").read_text(encoding="utf-8")
    for code, words, reason in DOCUMENTED_BREAK_REASONS:
        assert f"{code} {words}" in schema
        assert BREAK_REASONS[code] is reason
    assert set(BREAK_REASONS) == {code for code, _, _ in DOCUMENTED_BREAK_REASONS}
