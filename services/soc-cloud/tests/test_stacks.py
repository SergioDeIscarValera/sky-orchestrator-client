"""The stacks' status, envelope and flight-file address, against fakes (FR-LNK-08, FR-LNK-09).

The wayline API and the database's functions are in-memory fakes, so the watcher's behaviour
is held without a network or a container: the readings as returned, null when unknown, one
stack hanging while another is recorded on time, the flight-file address once, the latest
reading kept while the database is away, and each change of reachability logged once.
"""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import msgspec
import pytest
from structlog.testing import capture_logs

from soc_cloud.so_api import Envelope, SoApiError, StackStatus
from soc_cloud.stacks import Kind, StackRecorder, StackSource, StackWatcher
from soc_db import DatabaseUnavailableError

DOCK = "SOTESTDOCK01"
OTHER_DOCK = "SOTESTDOCK02"
FILES = "http://soc-cloud:8090"
SHA_CONFIG = "a" * 64
SHA_ENVELOPE = "b" * 64

STATUS_WIRE: dict[str, Any] = {
    "schema_version": "1.3.0",
    "at_ms": 1791000000000,
    "simulator_mode": True,
    "link": {"state": "up", "reason": "connected", "changed_at_ms": 1790999900000},
    "simulator_active": True,
    "aircraft_connected": True,
    "aircraft_online": True,
    "aircraft_reason": "link up, aircraft connected, telemetry fresh",
    "armed": True,
    "arming_remaining_s": 42,
    "clock_offset_ms": -180,
    "clock_offset_uncertainty_ms": 25,
    "contract_version": "2.1.0",
    "config_fingerprint": SHA_CONFIG,
    "warnings": [{"code": "clock_offset_beyond_limit", "message": "clock 180 ms behind"}],
}
ENVELOPE_WIRE: dict[str, Any] = {
    "envelope": {
        "geofence_center": {"latitude_deg": 45.0, "longitude_deg": 7.0},
        "geofence_radius_m": 3000.0,
        "max_height_m": 120.0,
        "max_home_distance_m": 2500.0,
        "max_leg_m": 1500.0,
        "max_transit_m": 2000.0,
        "max_total_distance_m": 20000.0,
        "max_waypoints": 200,
        "max_horizontal_speed_ms": 15.0,
    },
    "envelope_fingerprint": SHA_ENVELOPE,
    "config_fingerprint": SHA_CONFIG,
    "application_in_force": None,
}


def decoded[T](kind: type[T], wire: dict[str, Any]) -> T:
    return msgspec.json.decode(msgspec.json.encode(wire), type=kind)


class FakeWayline:
    """A stack's wayline API: it answers what the test sets, fails the next calls it is given,
    or never answers, and records every call."""

    def __init__(self) -> None:
        self.status_value = decoded(StackStatus, STATUS_WIRE)
        self.envelope_value = decoded(Envelope, ENVELOPE_WIRE)
        self.status_failures: list[SoApiError] = []
        self.envelope_failures: list[SoApiError] = []
        self.status_hangs = False
        self.envelope_hangs = False
        self.calls: list[str] = []

    async def status(self) -> StackStatus:
        self.calls.append("status")
        await self._answer(self.status_hangs, self.status_failures)
        return self.status_value

    async def envelope(self) -> Envelope:
        self.calls.append("envelope")
        await self._answer(self.envelope_hangs, self.envelope_failures)
        return self.envelope_value

    async def _answer(self, hangs: bool, failures: list[SoApiError]) -> None:
        if hangs:
            await asyncio.Event().wait()
        if failures:
            raise failures.pop(0)


class FakeStore:
    """soc.stacks as the watcher sees it: a row per gateway, and the functions that write it.
    As in the database, a status, an envelope or a files address for a gateway with no row is
    dropped, and the files address is read back."""

    def __init__(self) -> None:
        self.rows: set[str] = set()
        self.urls: dict[str, str] = {}
        self.url_writes: list[tuple[str, str]] = []
        self.statuses: list[tuple[str, str | None]] = []
        self.envelopes: list[tuple[str, str | None]] = []
        self.failures: list[BaseException] = []

    def _fail_if_asked(self) -> None:
        if self.failures:
            raise self.failures.pop(0)

    async def record_files_url(self, gateway: str, url: str) -> None:
        self._fail_if_asked()
        self.url_writes.append((gateway, url))
        if gateway in self.rows:
            self.urls[gateway] = url

    async def files_url(self, gateway: str) -> str | None:
        self._fail_if_asked()
        return self.urls.get(gateway)

    async def record_status(self, gateway: str, status: str | None) -> None:
        self._fail_if_asked()
        if gateway in self.rows:
            self.statuses.append((gateway, status))

    async def record_envelope(self, gateway: str, envelope: str | None) -> None:
        self._fail_if_asked()
        if gateway in self.rows:
            self.envelopes.append((gateway, envelope))

    def last_status(self) -> str | None:
        return self.statuses[-1][1] if self.statuses else None


def stack(name: str, gateways: Iterable[str] = ()) -> StackSource:
    heard = frozenset(gateways)
    return StackSource(name, FILES, lambda: heard)


async def until(condition: Callable[[], bool], within_s: float = 1.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.002)


@asynccontextmanager
async def watching(
    store: FakeStore,
    sources: list[StackSource],
    apis: dict[str, FakeWayline],
    *,
    status_poll_ms: float = 5,
    envelope_poll_s: float = 0.005,
) -> AsyncIterator[asyncio.Task[None]]:
    watcher = StackWatcher(
        sources,
        store,
        status_poll_ms=status_poll_ms,
        envelope_poll_s=envelope_poll_s,
        retry_s=0.001,
    )
    task = asyncio.create_task(watcher.run(apis))
    try:
        yield task
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_a_status_read_is_recorded_as_the_stack_returned_it() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: bool(store.statuses))
    gateway, text = store.statuses[0]
    assert gateway == DOCK
    assert text is not None and json.loads(text) == STATUS_WIRE


async def test_a_field_the_stack_does_not_know_is_recorded_as_null() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    wire = copy.deepcopy(STATUS_WIRE)
    wire["simulator_mode"] = None
    wire["warnings"] = None
    api.status_value = decoded(StackStatus, wire)
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: bool(store.statuses))
    recorded = json.loads(store.last_status() or "{}")
    assert recorded["simulator_mode"] is None
    assert recorded["warnings"] is None
    assert recorded["armed"] is True


async def test_an_envelope_read_is_recorded_as_the_stack_returned_it() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: bool(store.envelopes))
    gateway, text = store.envelopes[0]
    assert gateway == DOCK
    assert text is not None and json.loads(text) == ENVELOPE_WIRE


async def test_an_unreachable_stack_records_null_and_a_reachable_one_its_value() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: store.last_status() is not None)
        api.status_failures = [SoApiError("GET /v1/status answered 503", status=503)] * 3
        await until(lambda: store.last_status() is None)
        await until(lambda: store.last_status() is not None)
    assert json.loads(store.last_status() or "{}") == STATUS_WIRE


async def test_a_stack_with_no_answer_within_its_interval_is_unknown() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    api.status_hangs = True
    with capture_logs() as logs:
        async with watching(store, [stack("lab", [DOCK])], {"lab": api}, status_poll_ms=20):
            await until(lambda: bool(store.statuses))
    assert store.statuses and all(text is None for _, text in store.statuses)
    unreachable = [line for line in logs if line["event"] == "stack_api_unreachable"]
    assert unreachable[0]["error"] == "no answer within 0.02 s"


async def test_a_stack_that_hangs_delays_no_other_stack() -> None:
    store = FakeStore()
    store.rows.update({DOCK, OTHER_DOCK})
    hanging, answering = FakeWayline(), FakeWayline()
    hanging.status_hangs = True
    hanging.envelope_hangs = True
    sources = [stack("lab", [DOCK]), stack("field", [OTHER_DOCK])]
    apis = {"lab": hanging, "field": answering}
    async with watching(store, sources, apis, status_poll_ms=20, envelope_poll_s=0.02):
        await until(lambda: sum(gateway == OTHER_DOCK for gateway, _ in store.statuses) >= 5)
    other = [text for gateway, text in store.statuses if gateway == OTHER_DOCK]
    assert other and all(text is not None for text in other)
    assert all(text is None for gateway, text in store.statuses if gateway == DOCK)


async def test_a_status_that_hangs_does_not_stop_the_envelope() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    api.envelope_hangs = True
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}, status_poll_ms=10):
        await until(lambda: sum(text is not None for _, text in store.statuses) >= 5)
    assert store.envelopes and all(text is None for _, text in store.envelopes)
    assert api.calls.count("status") >= 5


async def test_the_files_address_is_recorded_once_for_a_gateway_once_heard() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: len(api.calls) >= 20)
    assert store.url_writes == [(DOCK, FILES)]
    assert store.urls == {DOCK: FILES}


async def test_the_files_address_is_written_again_until_the_row_shows_it() -> None:
    store, api = FakeStore(), FakeWayline()
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
        await until(lambda: len(store.url_writes) >= 2)
        store.rows.add(DOCK)
        await until(lambda: store.urls.get(DOCK) == FILES)
        written = len(store.url_writes)
        await until(lambda: len(api.calls) >= 40)
    assert len(store.url_writes) == written


async def test_a_gateway_heard_after_start_gets_its_files_address_and_its_reading() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    heard: set[str] = set()
    source = StackSource("lab", FILES, lambda: frozenset(heard))
    async with watching(store, [source], {"lab": api}):
        await until(lambda: len(api.calls) >= 4)
        assert store.statuses == [] and store.url_writes == []
        heard.add(DOCK)
        await until(lambda: bool(store.statuses))
    assert store.url_writes == [(DOCK, FILES)]


async def test_each_stack_is_recorded_under_the_gateway_its_own_link_heard() -> None:
    store = FakeStore()
    store.rows.update({DOCK, OTHER_DOCK})
    lab, field = FakeWayline(), FakeWayline()
    field.status_value = decoded(StackStatus, {**STATUS_WIRE, "at_ms": 7})
    sources = [stack("lab", [DOCK]), stack("field", [OTHER_DOCK])]
    async with watching(store, sources, {"lab": lab, "field": field}):
        await until(lambda: {gateway for gateway, _ in store.statuses} == {DOCK, OTHER_DOCK})
    recorded = {gateway: json.loads(text or "{}") for gateway, text in store.statuses}
    assert recorded[OTHER_DOCK]["at_ms"] == 7
    assert recorded[DOCK]["at_ms"] == STATUS_WIRE["at_ms"]


async def test_while_the_database_is_away_only_the_latest_reading_is_written() -> None:
    store = FakeStore()
    store.rows.add(DOCK)
    recorder = StackRecorder(store, [stack("lab", [DOCK])], retry_s=0.001)
    assert await recorder.flush()
    store.failures = [DatabaseUnavailableError("away")] * 3
    for text in ("one", "two", "three"):
        recorder.reading("lab", Kind.STATUS, text)
        assert not await recorder.flush()
    assert await recorder.flush()
    assert store.statuses == [(DOCK, "three")]


async def test_the_watcher_keeps_running_while_the_database_is_away() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    store.failures = [DatabaseUnavailableError("away")] * 5
    async with watching(store, [stack("lab", [DOCK])], {"lab": api}) as task:
        await until(lambda: bool(store.statuses))
        assert not task.done()
    assert store.last_status() is not None


async def test_a_reading_the_database_refuses_is_dropped_and_the_next_is_written() -> None:
    store = FakeStore()
    store.rows.add(DOCK)
    recorder = StackRecorder(store, [stack("lab", [DOCK])], retry_s=0.001)
    assert await recorder.flush()
    store.failures = [asyncpg.CheckViolationError("refused")]
    recorder.reading("lab", Kind.STATUS, "refused")
    assert await recorder.flush()
    recorder.reading("lab", Kind.STATUS, "next")
    assert await recorder.flush()
    assert store.statuses == [(DOCK, "next")]


async def test_each_change_of_reachability_is_logged_once_not_every_poll() -> None:
    store, api = FakeStore(), FakeWayline()
    store.rows.add(DOCK)
    api.status_failures = [SoApiError("GET /v1/status answered 503", status=503)] * 6
    with capture_logs() as logs:
        async with watching(store, [stack("lab", [DOCK])], {"lab": api}):
            await until(lambda: api.calls.count("status") >= 10)
    status_events = [
        line["event"]
        for line in logs
        if line["event"].startswith("stack_api_") and line.get("endpoint") == "status"
    ]
    assert status_events == ["stack_api_unreachable", "stack_api_reachable"]
