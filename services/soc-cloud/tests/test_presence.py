from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence

import asyncpg
import pytest

from soc_cloud.presence import Device, LinkState, PresenceRecorder, StackReport
from soc_db import DatabaseUnavailableError

DOCK = "SOTESTDOCK01"
ORGANIZATION = uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a")
AIRCRAFT = Device("SOTESTUAV001", 0, 91, 0, online=True)


class FakeStore:
    def __init__(self) -> None:
        self.written: list[tuple[object, ...]] = []
        self.failures: list[BaseException] = []

    def _fail_if_asked(self) -> None:
        if self.failures:
            raise self.failures.pop(0)

    async def record_stack(self, report: StackReport) -> None:
        self._fail_if_asked()
        self.written.append(("stack", report.gateway, report.state))

    async def record_topology(self, gateway: str, devices: Sequence[Device]) -> int:
        self._fail_if_asked()
        self.written.append(("topology", gateway, tuple(devices)))
        return sum(device.online for device in devices)

    async def record_firmware(self, gateway: str, aircraft: str, version: str) -> None:
        self._fail_if_asked()
        self.written.append(("firmware", gateway, aircraft, version))


def recorder() -> tuple[PresenceRecorder, FakeStore]:
    store = FakeStore()
    return PresenceRecorder(store, retry_s=0.001), store


def connected(gateway: str = DOCK) -> StackReport:
    return StackReport(gateway, "lab", ORGANIZATION, LinkState.CONNECTED)


async def test_a_device_waits_for_its_stack_and_is_written_after_it() -> None:
    presence, store = recorder()
    presence.record_topology(DOCK, [AIRCRAFT])
    presence.record_firmware(DOCK, AIRCRAFT.aircraft_sn, "10.1.0")
    assert await presence.flush()
    assert store.written == []
    presence.record_stack(connected())
    assert await presence.flush()
    assert [entry[0] for entry in store.written] == ["stack", "topology", "firmware"]


async def test_only_the_latest_report_is_written_and_a_repeat_is_not() -> None:
    presence, store = recorder()
    presence.record_stack(connected())
    for online in (True, False, True, False):
        presence.record_topology(DOCK, [Device("SOTESTUAV001", 0, 91, 0, online)])
    await presence.flush()
    presence.record_stack(connected())
    presence.record_topology(DOCK, [Device("SOTESTUAV001", 0, 91, 0, online=False)])
    await presence.flush()
    topologies = [entry for entry in store.written if entry[0] == "topology"]
    assert topologies == [("topology", DOCK, (Device("SOTESTUAV001", 0, 91, 0, False),))]
    assert len([entry for entry in store.written if entry[0] == "stack"]) == 1


async def test_what_the_database_missed_is_written_when_it_is_back() -> None:
    presence, store = recorder()
    store.failures = [DatabaseUnavailableError("away"), ConnectionResetError("lost")]
    presence.record_stack(connected())
    presence.record_topology(DOCK, [AIRCRAFT])
    assert not await presence.flush()
    assert not await presence.flush()
    assert await presence.flush()
    assert [entry[0] for entry in store.written] == ["stack", "topology"]


async def test_everything_known_is_written_again_after_a_reconnection() -> None:
    presence, store = recorder()
    presence.record_stack(connected())
    presence.record_topology(DOCK, [AIRCRAFT])
    presence.record_firmware(DOCK, AIRCRAFT.aircraft_sn, "10.1.0")
    await presence.flush()
    presence.rewrite_all()
    await presence.flush()
    assert [entry[0] for entry in store.written] == ["stack", "topology", "firmware"] * 2


async def test_what_the_database_refuses_is_dropped_and_the_rest_written() -> None:
    presence, store = recorder()
    store.failures = [asyncpg.CheckViolationError("serial refused")]
    presence.record_stack(connected())
    presence.record_stack(connected("SOTESTDOCK02"))
    assert await presence.flush()
    assert store.written == [("stack", "SOTESTDOCK02", LinkState.CONNECTED)]


async def test_the_recorder_keeps_trying_while_it_runs() -> None:
    presence, store = recorder()
    store.failures = [DatabaseUnavailableError("away")] * 3
    task = asyncio.create_task(presence.run())
    try:
        presence.record_stack(connected())
        async with asyncio.timeout(1):
            while not store.written:
                await asyncio.sleep(0.001)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert store.written == [("stack", DOCK, LinkState.CONNECTED)]


async def test_a_stack_presence_names_its_stack_and_organization() -> None:
    presence, store = recorder()
    presence.for_stack("lab", ORGANIZATION).link(DOCK, LinkState.DISPLACED)
    await presence.flush()
    assert store.written == [("stack", DOCK, LinkState.DISPLACED)]
