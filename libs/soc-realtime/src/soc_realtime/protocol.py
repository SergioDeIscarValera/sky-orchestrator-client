from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import msgspec

VSN = "1.0.0"
TOPIC_PREFIX = "realtime:"
PHOENIX = "phoenix"
JOIN = "phx_join"
REPLY = "phx_reply"
HEARTBEAT = "heartbeat"
BROADCAST = "broadcast"
CHANNEL_FAILURES = frozenset({"phx_error", "phx_close"})


class Frame(msgspec.Struct, frozen=True):
    topic: str
    event: str
    payload: dict[str, Any]
    ref: str | None = None
    join_ref: str | None = None


_ENCODER = msgspec.json.Encoder()
_DECODER = msgspec.json.Decoder(Frame)


def encode(frame: Frame) -> str:
    return _ENCODER.encode(frame).decode("utf-8")


def decode(text: str | bytes) -> Frame:
    return _DECODER.decode(text)


@dataclass(frozen=True)
class Message:
    topic: str
    event: str
    payload: Mapping[str, Any]


@dataclass(frozen=True)
class Endpoint:
    base: str
    key: str = field(repr=False)

    def websocket_url(self) -> str:
        parts = urlsplit(self.base.rstrip("/"))
        scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
        query = urlencode({"apikey": self.key, "vsn": VSN})
        return urlunsplit((scheme, parts.netloc, f"{parts.path}/websocket", query, ""))

    def broadcast_url(self) -> str:
        parts = urlsplit(self.base.rstrip("/"))
        scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
        path = parts.path.removesuffix("/socket")
        return urlunsplit((scheme, parts.netloc, f"{path}/api/broadcast", "", ""))


def join(topic: str, ref: str, access_token: str) -> Frame:
    return Frame(
        topic=TOPIC_PREFIX + topic,
        event=JOIN,
        payload={
            "config": {
                "broadcast": {"ack": False, "self": False},
                "presence": {"key": "", "enabled": False},
                "postgres_changes": [],
                "private": True,
            },
            "access_token": access_token,
        },
        ref=ref,
        join_ref=ref,
    )


def heartbeat(ref: str) -> Frame:
    return Frame(topic=PHOENIX, event=HEARTBEAT, payload={}, ref=ref)


def broadcast(message: Message, ref: str, join_ref: str) -> Frame:
    return Frame(
        topic=TOPIC_PREFIX + message.topic,
        event=BROADCAST,
        payload={"type": BROADCAST, "event": message.event, "payload": dict(message.payload)},
        ref=ref,
        join_ref=join_ref,
    )
