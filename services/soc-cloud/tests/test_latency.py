from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence

import pytest
from structlog.testing import capture_logs

from soc_cloud.fanout import Fanout
from soc_cloud.latency import Latencies, nearest_rank
from soc_cloud.link.telemetry import Sample
from soc_realtime import Route
from soc_realtime.protocol import Message


def test_percentiles_are_values_that_were_measured() -> None:
    ordered = [float(value) for value in range(1, 101)]
    assert [nearest_rank(ordered, fraction) for fraction in (0.5, 0.95, 0.99)] == [50, 95, 99]
    assert nearest_rank([7.0], 0.99) == 7


def test_each_minute_logs_its_percentiles_then_starts_again() -> None:
    latencies = Latencies()
    for value in range(1, 21):
        latencies.record("telemetry_hold_ms", value)
    latencies.record("command_reply_ms", 42)
    with capture_logs() as logs:
        latencies.report()
        latencies.report()
    (line,) = logs
    assert line["event"] == "latency"
    assert line["telemetry_hold_ms"] == {"count": 20, "p50": 10, "p95": 19, "p99": 20}
    assert line["command_reply_ms"] == {"count": 1, "p50": 42, "p95": 42, "p99": 42}


async def test_the_reporter_reports_every_period() -> None:
    latencies = Latencies()
    latencies.record("telemetry_age_ms", 5)
    periods: list[float] = []

    async def sleep(seconds: float) -> None:
        periods.append(seconds)
        if len(periods) > 1:
            raise asyncio.CancelledError

    with capture_logs() as logs, pytest.raises(asyncio.CancelledError):
        await latencies.run(sleep, period_s=60)
    assert periods == [60, 60]
    assert [line["event"] for line in logs] == ["latency"]


class Sender:
    async def send(self, messages: Sequence[Message]) -> Route:
        return Route.SOCKET


async def test_telemetry_is_timed_from_the_aircraft_and_through_soc_cloud() -> None:
    now = [10.0]
    latencies = Latencies()
    fanout = Fanout(
        {"lab": uuid.uuid4()},
        5,
        clock=lambda: now[0],
        wall_ms=lambda: 1_790_800_000_300,
        latencies=latencies,
    )
    fanout.sampled(
        Sample(
            stack="lab",
            gateway="SOTESTDOCK01",
            aircraft="SOTESTUAV001",
            taken_at_ms=1_790_800_000_000,
            latitude_deg=None,
            longitude_deg=None,
            height_m=None,
            heading_deg=None,
            home_distance_m=None,
            battery_pct=None,
            satellites=None,
            gps_quality=None,
            mode_code=None,
        )
    )
    now[0] += 0.004
    await fanout.flush(Sender())
    summary = latencies.summary()
    assert summary["telemetry_age_ms"]["p50"] == 300
    assert summary["telemetry_hold_ms"]["p50"] == 4
