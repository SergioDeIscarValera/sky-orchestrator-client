"""The DJI Cloud API topics a cloud reads and answers on (Sky Orchestrator's wire.py)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

SERIAL = re.compile(r"^[A-Za-z0-9]+$")


class Inbound(StrEnum):
    STATUS = "status"
    OSD = "osd"
    STATE = "state"
    EVENTS = "events"
    REQUESTS = "requests"
    SERVICES_REPLY = "services_reply"
    PROPERTY_SET_REPLY = "property/set_reply"


SUBSCRIPTIONS = (
    "sys/product/+/status",
    *(f"thing/product/+/{kind}" for kind in Inbound if kind is not Inbound.STATUS),
)


@dataclass(frozen=True)
class Topic:
    kind: Inbound
    sn: str


def parse(topic: str) -> Topic | None:
    parts = topic.split("/")
    if len(parts) < 4 or parts[1] != "product" or not SERIAL.match(parts[2]):
        return None
    suffix = "/".join(parts[3:])
    if parts[0] == "sys":
        return Topic(Inbound.STATUS, parts[2]) if suffix == Inbound.STATUS else None
    if parts[0] != "thing" or suffix == Inbound.STATUS:
        return None
    try:
        return Topic(Inbound(suffix), parts[2])
    except ValueError:
        return None


def status_reply(gateway: str) -> str:
    return f"sys/product/{gateway}/status_reply"


def requests_reply(gateway: str) -> str:
    return f"thing/product/{gateway}/requests_reply"


def services(gateway: str) -> str:
    return f"thing/product/{gateway}/services"
