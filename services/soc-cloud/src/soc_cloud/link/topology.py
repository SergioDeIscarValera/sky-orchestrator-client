"""Which aircraft are online on a stack (FR-LNK-02).

An aircraft is online only while the dock's last update_topo lists it and the
dock's OSD reports it online.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from soc_cloud.link.messages import DockOsd, SubDevice, TopologyData
from soc_cloud.presence import Device


@dataclass(frozen=True)
class Change:
    gateway: str
    aircraft: str
    online: bool


@dataclass
class Gateway:
    listed: dict[str, SubDevice] = field(default_factory=dict)
    reported_online: dict[str, bool] = field(default_factory=dict)

    def online(self) -> set[str]:
        return {sn for sn in self.listed if self.reported_online.get(sn, False)}


class Topology:
    def __init__(self) -> None:
        self._gateways: dict[str, Gateway] = {}

    def online(self) -> set[str]:
        return {sn for gateway in self._gateways.values() for sn in gateway.online()}

    def gateways(self) -> set[str]:
        return set(self._gateways)

    def devices(self, gateway: str) -> list[Device]:
        """Every aircraft the gateway lists, each online or not as it is now."""
        state = self._gateways.get(gateway, Gateway())
        online = state.online()
        return [
            Device(sn, listed.domain, listed.type, listed.sub_type, sn in online)
            for sn, listed in sorted(state.listed.items())
        ]

    def gateway_of(self, aircraft: str) -> str | None:
        return next(
            (sn for sn, gateway in self._gateways.items() if aircraft in gateway.listed), None
        )

    def announce(self, gateway: str, data: TopologyData) -> list[Change]:
        state = self._gateways.setdefault(gateway, Gateway())
        before = state.online()
        state.listed = {device.sn: device for device in data.sub_devices}
        return _changes(gateway, before, state.online())

    def report(self, gateway: str, osd: DockOsd) -> list[Change]:
        if osd.sub_device is None:
            return []
        state = self._gateways.setdefault(gateway, Gateway())
        before = state.online()
        state.reported_online[osd.sub_device.device_sn] = osd.sub_device.device_online_status == 1
        return _changes(gateway, before, state.online())


def _changes(gateway: str, before: set[str], after: set[str]) -> list[Change]:
    return [Change(gateway, sn, True) for sn in sorted(after - before)] + [
        Change(gateway, sn, False) for sn in sorted(before - after)
    ]
