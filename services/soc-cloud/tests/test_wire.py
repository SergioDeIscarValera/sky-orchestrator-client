from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest

from soc_cloud.wire import MQTT, WireContract, WireRefusedError

CONTRACT = WireContract()
EXAMPLES = sorted((MQTT / "examples").glob("*.json"))


def kind_of(example: Path) -> str:
    topic_kind, _, rest = example.stem.partition(".")
    return f"{topic_kind}/{rest.partition('.')[0]}"


def status_reply(**changes: Any) -> dict[str, Any]:
    return {
        "tid": str(uuid.uuid4()),
        "bid": str(uuid.uuid4()),
        "timestamp": 1790800000000,
        "method": "update_topo",
        "data": {"result": 0},
        **changes,
    }


def test_every_dji_schema_is_loaded() -> None:
    assert "sys/status_reply" in CONTRACT.kinds
    assert "requests/flighttask_resource_get_reply" in CONTRACT.kinds
    assert "dji-envelope" not in CONTRACT.kinds
    assert len(CONTRACT.kinds) == 19


@pytest.mark.parametrize("example", EXAMPLES, ids=lambda path: path.stem)
def test_every_vendored_example_passes_its_schema(example: Path) -> None:
    message = json.loads(example.read_text(encoding="utf-8"))
    assert CONTRACT.problems(kind_of(example), message) == []


def test_a_status_reply_as_soc_sends_it_passes() -> None:
    CONTRACT.check("sys/status_reply", status_reply())


def test_a_reply_without_its_result_is_refused_and_says_why() -> None:
    with pytest.raises(WireRefusedError) as refused:
        CONTRACT.check("sys/status_reply", status_reply(data={}))
    assert refused.value.kind == "sys/status_reply"
    assert refused.value.problems == ['data: "result" is a required property']


def test_the_envelope_is_enforced_through_its_reference() -> None:
    problems = CONTRACT.problems("sys/status_reply", status_reply(timestamp=-1))
    assert len(problems) == 1
    assert problems[0].startswith("timestamp: ")


def test_a_cloud_message_may_carry_more_fields() -> None:
    CONTRACT.check("sys/status_reply", status_reply(gateway="SOTESTDOCK01"))


def test_a_dock_message_may_not() -> None:
    example = json.loads((MQTT / "examples" / "sys.update_topo.json").read_text())
    assert CONTRACT.problems("sys/update_topo", {**example, "extra": 1}) != []


def test_an_unknown_kind_is_a_programming_error() -> None:
    with pytest.raises(KeyError):
        CONTRACT.problems("sys/unknown", {})
