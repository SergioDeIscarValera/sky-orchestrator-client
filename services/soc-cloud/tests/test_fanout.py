from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Sequence
from pathlib import Path

import jsonschema_rs
import pytest

from soc_cloud.fanout import Fanout
from soc_cloud.link.telemetry import Sample
from soc_realtime import Message, Route

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "broadcast" / "telemetry.schema.json"
SCHEMA = jsonschema_rs.validator_for(json.loads(CONTRACT.read_text(encoding="utf-8")))
FARM = uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a")
ORCHARD = uuid.UUID("0b6d3f1e-8a2c-4e5f-9b1a-7c3d2e1f0a9b")
SENT_AT_MS = 1_790_800_000_500


class FakeSender:
    def __init__(self, route: Route = Route.SOCKET) -> None:
        self.sends: list[list[Message]] = []
        self.route = route

    async def send(self, messages: Sequence[Message]) -> Route:
        self.sends.append(list(messages))
        return self.route


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def sample(
    aircraft: str = "SOTESTUAV001", stack: str = "lab", taken_at_ms: int = 1_790_800_000_000
) -> Sample:
    return Sample(
        stack=stack,
        gateway="SOTESTDOCK01",
        aircraft=aircraft,
        taken_at_ms=taken_at_ms,
        latitude_deg=41.6523,
        longitude_deg=-4.7245,
        height_m=35.2,
        heading_deg=-12.5,
        home_distance_m=40.0,
        battery_pct=87,
        satellites=None,
        gps_quality=5,
        mode_code=0,
    )


def fanout(clock: Clock, max_rate_hz: int = 5) -> Fanout:
    return Fanout(
        {"lab": FARM, "field": ORCHARD}, max_rate_hz, clock=clock, wall_ms=lambda: SENT_AT_MS
    )


async def test_a_sample_goes_to_its_stacks_organization_as_the_contract_says() -> None:
    sender, clock = FakeSender(), Clock()
    out = fanout(clock)
    out.sampled(sample())
    out.sampled(sample(stack="field", aircraft="SOTESTUAV002"))
    await out.flush(sender)
    (messages,) = sender.sends
    assert [(message.topic, message.event) for message in messages] == [
        (f"org:{FARM}:soc:telemetry", "sample"),
        (f"org:{ORCHARD}:soc:telemetry", "sample"),
    ]
    first = dict(messages[0].payload)
    assert list(SCHEMA.iter_errors(first)) == []
    assert first["sent_at_ms"] == SENT_AT_MS
    assert first["satellites"] is None


async def test_a_stack_soc_cloud_does_not_serve_sends_nothing() -> None:
    sender, clock = FakeSender(), Clock()
    out = fanout(clock)
    out.sampled(sample(stack="elsewhere"))
    await out.flush(sender)
    assert sender.sends == []


async def test_an_aircraft_is_sent_at_most_its_rate_and_the_latest_sample_wins() -> None:
    sender, clock = FakeSender(), Clock()
    out = fanout(clock, max_rate_hz=4)
    out.sampled(sample(taken_at_ms=1))
    await out.flush(sender)
    clock.now += 0.0625
    out.sampled(sample(taken_at_ms=2))
    await out.flush(sender)
    clock.now += 0.0625
    out.sampled(sample(taken_at_ms=3))
    await out.flush(sender)
    assert len(sender.sends) == 1
    clock.now += 0.125
    await out.flush(sender)
    sent = [message.payload["taken_at_ms"] for messages in sender.sends for message in messages]
    assert sent == [1, 3]


async def test_samples_lost_by_both_routes_are_counted() -> None:
    sender, clock = FakeSender(Route.DROPPED), Clock()
    out = fanout(clock)
    out.sampled(sample())
    await out.flush(sender)
    assert (out.sent, out.dropped) == (0, 1)


async def test_the_running_fanout_sends_as_samples_arrive() -> None:
    sender = FakeSender()
    out = Fanout({"lab": FARM}, 25)
    task = asyncio.create_task(out.run(sender))
    try:
        for taken_at_ms in range(1, 6):
            out.sampled(sample(taken_at_ms=taken_at_ms))
            async with asyncio.timeout(1):
                while out.sent < taken_at_ms:
                    await asyncio.sleep(0.001)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    sent = [message.payload["taken_at_ms"] for messages in sender.sends for message in messages]
    assert sent == [1, 2, 3, 4, 5]
