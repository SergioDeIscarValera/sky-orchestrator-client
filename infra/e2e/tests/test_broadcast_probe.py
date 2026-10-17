"""DEP-23 on the container lane: soc-broadcast-probe against the platform, as the box runs it.

Virtual Origen's platform behind Kong, soc-cloud on one stack, a dock announcing and flying
an aircraft on the broker. The probe runs as its own process, given the environment the
compose service gives it, and joins a member's telemetry topic through Kong. A stranger is
refused before the run and after it, and the member keeps receiving across a restart of the
Realtime container (M1's Broadcast criterion, NFR-PERF-01).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import uuid
from pathlib import Path

import pytest

from soc_cloud.testing import EphemeralMosquitto
from soc_database.harness import Tenancy
from soc_e2e.cloud import running_cloud
from soc_e2e.dock import Dock
from soc_e2e.platform import Platform
from soc_geo.projection import Geodetic

pytestmark = pytest.mark.lane

GATEWAY = "SOTESTDOCK02"
AIRCRAFT = "SOTESTUAV002"
FINCA_NORTE = Geodetic(41.6523, -4.7245)
#: The probe's window, and when the Realtime container is restarted inside it.
WINDOW_S = 30
RESTART_AT_S = 8
#: The probe's own exit wait: its window, its two checks, and Python's start.
EXIT_WITHIN_S = WINDOW_S + 120
#: DEP-23's pass condition; the lane holds the box to the same figure.
MAX_P95_MS = 150


async def enrol(platform: Platform, user: uuid.UUID, email: str) -> None:
    """The profile a platform user needs before an organization can list them."""
    admin = await platform.stack.postgres.connect("supabase_admin")
    try:
        await admin.execute(
            "insert into public.profiles (id, display_name, email) values ($1, 'Probe', $2)",
            user,
            email,
        )
    finally:
        await admin.close()


async def farm_of(platform: Platform, user: uuid.UUID, email: str) -> uuid.UUID:
    """An organization the member owns, with a site the console can centre on."""
    await enrol(platform, user, email)
    admin = await platform.stack.postgres.connect("supabase_admin")
    try:
        return await Tenancy(admin).organization(
            user,
            name="Finca Norte",
            position=(FINCA_NORTE.latitude_deg, FINCA_NORTE.longitude_deg),
            timezone="Europe/Madrid",
        )
    finally:
        await admin.close()


def probe_environment(
    platform: Platform, member: tuple[str, str], stranger: tuple[str, str]
) -> dict[str, str]:
    """The probe's environment as compose passes it: its own SOC_PROBE_* and nothing else of
    the test's."""
    inherited = {
        name: value for name, value in os.environ.items() if not name.startswith("SOC_PROBE_")
    }
    return inherited | {
        "SOC_PROBE_ANON_KEY": platform.anon_key(),
        "SOC_PROBE_EMAIL": member[0],
        "SOC_PROBE_PASSWORD": member[1],
        "SOC_PROBE_OUTSIDER_EMAIL": stranger[0],
        "SOC_PROBE_OUTSIDER_PASSWORD": stranger[1],
    }


async def test_the_probe_joins_a_member_refuses_a_stranger_and_resumes_across_a_restart(
    platform: Platform,
    broker: EphemeralMosquitto,
    passwords: dict[str, str],
    tmp_path: Path,
) -> None:
    member_email = f"member-{secrets.token_hex(4)}@soc.test"
    member_secret = secrets.token_hex(16)
    stranger_email = f"stranger-{secrets.token_hex(4)}@soc.test"
    stranger_secret = secrets.token_hex(16)
    member = platform.create_user(member_email, member_secret)
    stranger = platform.create_user(stranger_email, stranger_secret)
    organization = await farm_of(platform, member, member_email)
    await enrol(platform, stranger, stranger_email)
    environment = probe_environment(
        platform, (member_email, member_secret), (stranger_email, stranger_secret)
    )
    command = [
        sys.executable,
        "-m",
        "soc_cloud.probe",
        "--supabase-url",
        platform.url,
        "--organization",
        str(organization),
        "--seconds",
        str(WINDOW_S),
    ]

    async with (
        running_cloud(platform, broker, passwords, organization, tmp_path),
        broker.dock(identifier="probe-dock") as client,
    ):
        dock = Dock(client, GATEWAY, AIRCRAFT, FINCA_NORTE)
        tasks = [asyncio.create_task(dock.announce()), asyncio.create_task(dock.fly())]
        try:
            probe = await asyncio.create_subprocess_exec(
                *command,
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.sleep(RESTART_AT_S)
            # The box's own step (docs/mini-pc-deployment.md, 3.3): Realtime restarts mid-run.
            await asyncio.to_thread(platform.stack.restart_realtime)
            stdout, stderr = await asyncio.wait_for(probe.communicate(), EXIT_WITHIN_S)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.wait(tasks)

    printed = stdout.decode() + stderr.decode()
    print(f"soc-broadcast-probe: {stdout.decode().strip()}")
    # The probe never prints a credential or a token (DEP-23's secrets rule).
    for secret in (
        member_secret,
        stranger_secret,
        member_email,
        stranger_email,
        platform.anon_key(),
    ):
        assert secret not in printed
    assert probe.returncode == 0, stderr.decode()
    summary = json.loads(stdout)
    assert summary["samples"] > 0
    # The member's socket dropped with the restart and was joined again (NFR-REL-06's shape).
    assert summary["reconnects"] >= 1
    assert summary["outsider_refused"] is True
    assert summary["p95_ms"] <= MAX_P95_MS
