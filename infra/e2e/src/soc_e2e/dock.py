"""A dock on the wire as so-gateway is one: it announces its aircraft, then flies it.

The messages are Sky Orchestrator's vendored examples with their identifiers, times
and positions filled in, so soc-cloud reads what the real gateway sends. The flight
stands idle (mode 0) on the circle's start for a second, then circles the centre at
FLIGHT_HEIGHT_M above it, at RATE_HZ, as SO measured the phone's OSD.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from dataclasses import dataclass
from typing import Any

import aiomqtt

from soc_cloud.wire import MQTT
from soc_geo.projection import EastNorth, Geodetic, geodetic_at

RATE_HZ = 5
RADIUS_M = 60.0
SPEED_MS = 10.0
FLIGHT_HEIGHT_M = 30.0
IDLE_SAMPLES = 5
ANNOUNCE_EVERY_S = 0.5


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def announcement(aircraft: str, taken_at_ms: int) -> dict[str, Any]:
    """`update_topo` for one aircraft, as so-gateway publishes it on connecting."""
    example: dict[str, Any] = json.loads((MQTT / "examples" / "sys.update_topo.json").read_text())
    sub_device = {**example["data"]["sub_devices"][0], "sn": aircraft}
    return {
        **example,
        "tid": str(uuid.uuid4()),
        "bid": str(uuid.uuid4()),
        "timestamp": taken_at_ms,
        "data": {**example["data"], "sub_devices": [sub_device]},
    }


def osd(gateway: str, centre: Geodetic, index: int, taken_at_ms: int) -> dict[str, Any]:
    """The aircraft's OSD number `index`: idle on the circle's start, then circling."""
    example: dict[str, Any] = json.loads((MQTT / "examples" / "osd.aircraft.json").read_text())
    flying = index >= IDLE_SAMPLES
    seconds = max(0, index - IDLE_SAMPLES) / RATE_HZ
    angle = SPEED_MS * seconds / RADIUS_M
    point = geodetic_at(centre, EastNorth(RADIUS_M * math.cos(angle), RADIUS_M * math.sin(angle)))
    # Counter-clockwise seen from above: the heading is the tangent, clockwise from north.
    heading = math.degrees(math.atan2(-math.sin(angle), math.cos(angle)))
    data = {
        **example["data"],
        "latitude": point.latitude_deg,
        "longitude": point.longitude_deg,
        "elevation": FLIGHT_HEIGHT_M if flying else 0.0,
        "home_distance": 2 * RADIUS_M * abs(math.sin(angle / 2)),
        "attitude_head": (heading + 180) % 360 - 180,
        "mode_code": 5 if flying else 0,
    }
    return {
        **example,
        "tid": str(uuid.uuid4()),
        "bid": str(uuid.uuid4()),
        "timestamp": taken_at_ms,
        "gateway": gateway,
        "data": data,
    }


@dataclass
class Dock:
    """One gateway and its aircraft, publishing as the dock's MQTT user."""

    client: aiomqtt.Client
    gateway: str
    aircraft: str
    centre: Geodetic

    async def announce(self) -> None:
        """Announces the aircraft every ANNOUNCE_EVERY_S, until cancelled."""
        while True:
            message = announcement(self.aircraft, now_ms())
            await self.client.publish(
                f"sys/product/{self.gateway}/status", json.dumps(message), qos=1
            )
            await asyncio.sleep(ANNOUNCE_EVERY_S)

    async def fly(self) -> None:
        """Publishes its OSD at RATE_HZ, each stamped with the wall clock as it goes."""
        started = time.monotonic()
        for index in range(1_000_000):
            sample = osd(self.gateway, self.centre, index, now_ms())
            await self.client.publish(
                f"thing/product/{self.aircraft}/osd", json.dumps(sample), qos=1
            )
            await asyncio.sleep(max(0.0, started + (index + 1) / RATE_HZ - time.monotonic()))
