"""Recorded telemetry replayed through the fan-out (NFR-TEST-05).

Every recording in contracts/recordings is fed to soc-cloud's fan-out at the pace it
was received: what goes out is the recorded samples themselves, on the contract, at
most `broadcast_max_rate_hz` an aircraft, and each aircraft's last sample always.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest

from soc_cloud.fanout import Fanout
from soc_cloud.link.telemetry import Sample
from soc_realtime import Message, Route

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA = jsonschema_rs.validator_for(
    json.loads((CONTRACTS / "broadcast" / "telemetry.schema.json").read_text(encoding="utf-8"))
)
RECORDINGS = sorted((CONTRACTS / "recordings").glob("*.jsonl"))
FARM = uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a")
MAX_RATE_HZ = 5


class Sent:
    def __init__(self) -> None:
        self.messages: list[tuple[float, Message]] = []
        self.now = 0.0

    async def send(self, messages: Sequence[Message]) -> Route:
        self.messages.extend((self.now, message) for message in messages)
        return Route.SOCKET


def recorded(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def as_read(sample: dict[str, Any]) -> Sample:
    """The sample as soc-cloud's link would have read it from the OSD."""
    return Sample(
        stack=sample["stack"],
        gateway=sample["gateway_sn"],
        aircraft=sample["aircraft_sn"],
        taken_at_ms=sample["taken_at_ms"],
        latitude_deg=sample["latitude_deg"],
        longitude_deg=sample["longitude_deg"],
        height_m=sample["height_m"],
        heading_deg=sample["heading_deg"],
        home_distance_m=sample["home_distance_m"],
        battery_pct=sample["battery_pct"],
        satellites=sample["satellites"],
        gps_quality=sample["gps_quality"],
        mode_code=sample["mode_code"],
    )


def test_there_is_a_recording_to_replay() -> None:
    assert RECORDINGS != []


@pytest.mark.parametrize("path", RECORDINGS, ids=lambda path: path.name)
async def test_a_recording_replays_through_the_fanout_as_it_was_broadcast(path: Path) -> None:
    lines = recorded(path)
    stacks = {line["sample"]["stack"] for line in lines}
    sent = Sent()
    out = Fanout(dict.fromkeys(stacks, FARM), MAX_RATE_HZ, clock=lambda: sent.now)
    start = lines[0]["received_at_ms"]
    for line in lines:
        sent.now = (line["received_at_ms"] - start) / 1000
        out.sampled(as_read(line["sample"]))
        await out.flush(sent)
    # Whatever is still held goes out once its interval has passed.
    sent.now += 1
    await out.flush(sent)

    without_send_time = [
        {key: value for key, value in line["sample"].items() if key != "sent_at_ms"}
        for line in lines
    ]
    last_sent_at: dict[str, float] = {}
    for at, message in sent.messages:
        payload = dict(message.payload)
        assert list(SCHEMA.iter_errors(payload)) == []
        payload.pop("sent_at_ms")
        assert payload in without_send_time
        key = f"{payload['gateway_sn']}/{payload['aircraft_sn']}"
        assert at - last_sent_at.get(key, -1.0) >= 1 / MAX_RATE_HZ - 1e-9
        last_sent_at[key] = at
    for aircraft in {(sample["gateway_sn"], sample["aircraft_sn"]) for sample in without_send_time}:
        last = [
            sample
            for sample in without_send_time
            if (sample["gateway_sn"], sample["aircraft_sn"]) == aircraft
        ][-1]
        broadcast = [dict(message.payload) for _, message in sent.messages]
        assert last["taken_at_ms"] in [
            payload["taken_at_ms"]
            for payload in broadcast
            if (payload["gateway_sn"], payload["aircraft_sn"]) == aircraft
        ]
