"""The latencies soc-cloud can see, logged every minute (NFR-OBS-04).

- `telemetry_hold_ms`: from an OSD read to its broadcast leaving soc-cloud;
- `telemetry_age_ms`: from the aircraft's own timestamp to the OSD read, which
  carries the offset between the remote controller's clock and the mini-PC's;
- `command_publish_ms`: from the intent's request, on the database's clock, to
  its publish on the stack (`NFR-PERF-02`'s first half);
- `command_reply_ms`: from the publish to DJI's reply.

Percentiles are nearest-rank over the minute, so a value logged is one that was
measured. A minute with nothing measured logs nothing.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable

import soc_log

PERIOD_S = 60.0
PERCENTILES = {"p50": 0.50, "p95": 0.95, "p99": 0.99}

log = soc_log.get(__name__)


def nearest_rank(ordered: list[float], fraction: float) -> float:
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


class Latencies:
    def __init__(self) -> None:
        self._measured: dict[str, list[float]] = {}

    def record(self, metric: str, milliseconds: float) -> None:
        self._measured.setdefault(metric, []).append(milliseconds)

    def summary(self) -> dict[str, dict[str, float]]:
        summary: dict[str, dict[str, float]] = {}
        for metric, values in sorted(self._measured.items()):
            ordered = sorted(values)
            summary[metric] = {"count": len(ordered)} | {
                name: round(nearest_rank(ordered, fraction), 1)
                for name, fraction in PERCENTILES.items()
            }
        return summary

    def report(self) -> None:
        summary = self.summary()
        self._measured.clear()
        if summary:
            log.info("latency", period_s=PERIOD_S, **summary)

    async def run(
        self, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, period_s: float = PERIOD_S
    ) -> None:
        while True:
            await sleep(period_s)
            self.report()
