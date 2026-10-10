"""The shapes SOC reads from the dock. A field the dock leaves out decodes to None."""

from __future__ import annotations

import msgspec

UPDATE_TOPO = "update_topo"
RESOURCE_GET = "flighttask_resource_get"


class SubDevice(msgspec.Struct, frozen=True):
    sn: str
    domain: int
    type: int
    sub_type: int


class TopologyData(msgspec.Struct, frozen=True):
    domain: int
    type: int
    sub_type: int
    sub_devices: tuple[SubDevice, ...] = ()


class UpdateTopo(msgspec.Struct, frozen=True):
    tid: str
    bid: str
    timestamp: int
    method: str
    data: TopologyData


class Envelope(msgspec.Struct, frozen=True):
    tid: str
    bid: str
    timestamp: int
    gateway: str
    data: msgspec.Raw
    method: str | None = None


class DockSubDevice(msgspec.Struct, frozen=True):
    device_sn: str
    device_online_status: int = 0
    device_paired: int = 0


class DockOsd(msgspec.Struct, frozen=True):
    mode_code: int | None = None
    sub_device: DockSubDevice | None = None


class Battery(msgspec.Struct, frozen=True):
    capacity_percent: int | None = None


class PositionState(msgspec.Struct, frozen=True):
    gps_number: int | None = None
    quality: int | None = None


class AircraftOsd(msgspec.Struct, frozen=True):
    latitude: float | None = None
    longitude: float | None = None
    elevation: float | None = None
    attitude_head: float | None = None
    home_distance: float | None = None
    battery: Battery | None = None
    position_state: PositionState | None = None
    mode_code: int | None = None


class ResourceGet(msgspec.Struct, frozen=True):
    flight_id: str
