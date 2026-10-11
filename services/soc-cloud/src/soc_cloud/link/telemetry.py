"""An aircraft OSD as one sample, taken at the message's timestamp (FR-LNK-03).

A value the message lacks is None, never the previous sample's. Units and frames
follow Sky Orchestrator (ADR-0014): degrees, metres above the takeoff point,
heading 0 north and clockwise.
"""

from __future__ import annotations

import msgspec

from soc_cloud.link.messages import AircraftOsd


class Sample(msgspec.Struct, frozen=True, kw_only=True):
    stack: str
    gateway: str
    aircraft: str
    taken_at_ms: int
    latitude_deg: float | None
    longitude_deg: float | None
    height_m: float | None
    heading_deg: float | None
    home_distance_m: float | None
    battery_pct: int | None
    satellites: int | None
    gps_quality: int | None
    mode_code: int | None


def sample(stack: str, gateway: str, aircraft: str, taken_at_ms: int, osd: AircraftOsd) -> Sample:
    return Sample(
        stack=stack,
        gateway=gateway,
        aircraft=aircraft,
        taken_at_ms=taken_at_ms,
        latitude_deg=osd.latitude,
        longitude_deg=osd.longitude,
        height_m=osd.elevation,
        heading_deg=osd.attitude_head,
        home_distance_m=osd.home_distance,
        battery_pct=osd.battery.capacity_percent if osd.battery else None,
        satellites=osd.position_state.gps_number if osd.position_state else None,
        gps_quality=osd.position_state.quality if osd.position_state else None,
        mode_code=osd.mode_code,
    )
