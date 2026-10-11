"""Live telemetry to the browsers of the aircraft's organization (FR-TEL-01, ADR-0007).

Each sample goes to `org:<id>:soc:telemetry` of its stack's organization as one
`sample` event (contracts/broadcast/telemetry.schema.json). An aircraft is sent
at most `broadcast_max_rate_hz` times a second: a sample that arrives sooner
waits, and a newer one replaces it, so the browsers get the latest and the
Realtime tenant shared with Virtual Origen never more than that (NFR-RES-07).
Samples due together leave in one send, on the socket while the topic is joined
and through Realtime's HTTP endpoint otherwise.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol

import msgspec

import soc_log
from soc_cloud.link.telemetry import Sample
from soc_realtime import Message, Route

EVENT = "sample"

log = soc_log.get(__name__)


def telemetry_topic(organization: uuid.UUID) -> str:
    return f"org:{organization}:soc:telemetry"


class Sender(Protocol):
    async def send(self, messages: Sequence[Message]) -> Route: ...


class TelemetryPayload(msgspec.Struct, frozen=True):
    stack: str
    gateway_sn: str
    aircraft_sn: str
    taken_at_ms: int
    sent_at_ms: int
    latitude_deg: float | None
    longitude_deg: float | None
    height_m: float | None
    heading_deg: float | None
    home_distance_m: float | None
    battery_pct: int | None
    satellites: int | None
    gps_quality: int | None
    mode_code: int | None


def payload(sample: Sample, sent_at_ms: int) -> dict[str, object]:
    built = TelemetryPayload(
        stack=sample.stack,
        gateway_sn=sample.gateway,
        aircraft_sn=sample.aircraft,
        taken_at_ms=sample.taken_at_ms,
        sent_at_ms=sent_at_ms,
        latitude_deg=sample.latitude_deg,
        longitude_deg=sample.longitude_deg,
        height_m=sample.height_m,
        heading_deg=sample.heading_deg,
        home_distance_m=sample.home_distance_m,
        battery_pct=sample.battery_pct,
        satellites=sample.satellites,
        gps_quality=sample.gps_quality,
        mode_code=sample.mode_code,
    )
    return msgspec.structs.asdict(built)


class Fanout:
    def __init__(
        self,
        organizations: Mapping[str, uuid.UUID],
        max_rate_hz: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        self._organizations = dict(organizations)
        self._interval_s = 1 / max_rate_hz
        self._clock = clock
        self._wall_ms = wall_ms
        self._pending: dict[tuple[str, str], Sample] = {}
        self._last_sent: dict[tuple[str, str], float] = {}
        self._wake = asyncio.Event()
        self.sent = 0
        self.dropped = 0

    def sampled(self, sample: Sample) -> None:
        if sample.stack in self._organizations:
            self._pending[(sample.gateway, sample.aircraft)] = sample
            self._wake.set()

    async def run(self, sender: Sender) -> None:
        while True:
            wait_s = self._next_due_in()
            if wait_s is None or wait_s > 0:
                self._wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), wait_s)
                continue
            await self.flush(sender)

    async def flush(self, sender: Sender) -> None:
        now = self._clock()
        due = [key for key in self._pending if self._due_in(key, now) <= 0]
        if not due:
            return
        sent_at_ms = self._wall_ms()
        messages = []
        for key in due:
            sample = self._pending.pop(key)
            self._last_sent[key] = now
            topic = telemetry_topic(self._organizations[sample.stack])
            messages.append(Message(topic, EVENT, payload(sample, sent_at_ms)))
        route = await sender.send(messages)
        if route is Route.DROPPED:
            self.dropped += len(messages)
            log.warning("telemetry_dropped", samples=len(messages), dropped=self.dropped)
        else:
            self.sent += len(messages)

    def _next_due_in(self) -> float | None:
        if not self._pending:
            return None
        now = self._clock()
        return max(0.0, min(self._due_in(key, now) for key in self._pending))

    def _due_in(self, key: tuple[str, str], now: float) -> float:
        last = self._last_sent.get(key)
        return 0.0 if last is None else last + self._interval_s - now
