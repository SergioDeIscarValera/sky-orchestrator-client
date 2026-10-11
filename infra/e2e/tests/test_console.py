"""M2's exit criteria through the console, in Chrome (FR-FLE-02, FR-FLE-03, FR-TEL-01,
FR-TEL-02, NFR-PERF-01).

Virtual Origen's platform behind Kong, SOC's migrations, soc-cloud on one stack, a
dock announcing and flying an aircraft on the broker, and the console's own image:
an operator signs in, sees the aircraft appear, registers it as a fleet, and
watches it fly, then go stale when the dock falls silent.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from pathlib import Path

import pytest

from soc_check import Image
from soc_cloud.testing import EphemeralMosquitto
from soc_database.harness import Tenancy
from soc_e2e.cloud import running_cloud
from soc_e2e.console import browsing, serving
from soc_e2e.dock import RATE_HZ, Dock, now_ms
from soc_e2e.platform import Platform
from soc_geo.projection import Geodetic

pytestmark = pytest.mark.lane

GATEWAY = "SOTESTDOCK01"
AIRCRAFT = "SOTESTUAV001"
FINCA_NORTE = Geodetic(41.6523, -4.7245)
#: A minute at 5 Hz on the lane; SOC_E2E_SAMPLES=3000 runs NFR-PERF-01's ten minutes.
SAMPLES = int(os.environ.get("SOC_E2E_SAMPLES", "300"))
STALE_AFTER_MS = 3000


async def farm_of(platform: Platform, user: uuid.UUID, email: str) -> uuid.UUID:
    """The pilot's profile and organization, Finca Norte, which they own."""
    admin = await platform.stack.postgres.connect("supabase_admin")
    try:
        await admin.execute(
            "insert into public.profiles (id, display_name, email) values ($1, 'Pilot', $2)",
            user,
            email,
        )
        return await Tenancy(admin).organization(
            user,
            name="Finca Norte",
            position=(FINCA_NORTE.latitude_deg, FINCA_NORTE.longitude_deg),
            timezone="Europe/Madrid",
        )
    finally:
        await admin.close()


async def fleets_of(platform: Platform, organization: uuid.UUID) -> list[tuple[str, str, str]]:
    admin = await platform.stack.postgres.connect("supabase_admin")
    try:
        rows = await admin.fetch(
            "select name, gateway_sn, aircraft_sn from soc.fleets"
            " where organization_id = $1 and deleted_at is null",
            organization,
        )
    finally:
        await admin.close()
    return [(row["name"], row["gateway_sn"], row["aircraft_sn"]) for row in rows]


async def test_an_aircraft_announced_is_registered_and_flies_in_the_console(
    platform: Platform,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    console_image: Image,
    tmp_path: Path,
) -> None:
    email = f"pilot-{secrets.token_hex(4)}@soc.test"
    secret = secrets.token_hex(16)
    user = platform.create_user(email, secret)
    organization = await farm_of(platform, user, email)
    (tmp_path / "web").mkdir()
    driver = {
        "SOC_E2E_EMAIL": email,
        "SOC_E2E_PASSWORD": secret,
        "SOC_E2E_AIRCRAFT": AIRCRAFT,
        "SOC_E2E_SAMPLES": str(SAMPLES),
    }

    async with (
        running_cloud(platform, broker, passwords, organization, tmp_path) as cloud,
        broker.dock(identifier="e2e-dock") as client,
    ):
        dock = Dock(client, GATEWAY, AIRCRAFT, FINCA_NORTE)
        tasks: list[asyncio.Task[None]] = []
        try:
            with serving(console_image, platform.url, platform.anon_key(), tmp_path / "web") as url:
                async with browsing({**driver, "SOC_E2E_CONSOLE": url}) as browser:
                    await browser.expect("ready")
                    announced_at = now_ms()
                    tasks.append(asyncio.create_task(dock.announce()))
                    await browser.tell(announced_at_ms=announced_at)
                    device = await browser.expect("device")
                    await browser.expect("fleet")
                    registered = await fleets_of(platform, organization)

                    flying_since = now_ms()
                    flying = asyncio.create_task(dock.fly())
                    tasks.append(flying)
                    await browser.tell(flying_since_ms=flying_since)
                    telemetry = await browser.expect("telemetry", SAMPLES / RATE_HZ + 60)
                    hold = cloud.latencies.summary().get("telemetry_hold_ms")
                    flying.cancel()
                    await browser.tell(stopped=True)
                    stale = await browser.expect("stale")
                    layout = await browser.expect("layout")
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.wait(tasks, timeout=5) if tasks else None

    print(
        f"device in {device['appeared_after_ms']} ms;"
        f" dock to browser {telemetry['from_dock_ms']};"
        f" soc-cloud broadcast to browser {telemetry['from_cloud_ms']};"
        f" soc-cloud hold {hold}; console's delivery p95 {telemetry['console_delivery_p95_ms']} ms;"
        f" stale {stale['after_last_ms']} ms after the last sample"
    )
    # FR-FLE-02: an aircraft announced shows in the fleet panel within 2 s.
    assert device["appeared_after_ms"] <= 2000
    # FR-FLE-03: registered through the console's form, as the database holds it.
    assert registered == [("Norte 1", GATEWAY, AIRCRAFT)]
    # FR-TEL-01: every sample, in order, and the aircraft moves in the console.
    assert telemetry["from_dock_ms"]["count"] >= SAMPLES
    assert telemetry["in_order"]
    assert telemetry["moved"]
    assert telemetry["frames_drawn"] > 0
    # FR-SCN-05: the aircraft selected is followed, its label still on the screen as it flies.
    assert telemetry["followed"]
    assert telemetry["label_drift_px"] is not None
    assert telemetry["label_drift_px"] <= 40
    # NFR-PERF-01, from the dock's publish, before soc-cloud even reads it, to the browser.
    assert telemetry["from_dock_ms"]["p95"] <= 150
    assert telemetry["from_dock_ms"]["p99"] <= 300
    # FR-TEL-02: a frozen feed turns stale at the threshold, give or take 100 ms.
    assert STALE_AFTER_MS - 100 <= stale["after_last_ms"] <= STALE_AFTER_MS + 100
    # The map tools stay bottom right when the panel closes: they once jumped to the top.
    assert layout["map_tools_moved_px"] == 0
