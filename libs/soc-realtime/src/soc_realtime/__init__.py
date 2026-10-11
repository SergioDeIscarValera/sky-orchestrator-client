"""Realtime Broadcast on private channels, from the backend (ADR-0007, ADR-0017).

    endpoint = Endpoint("http://kong:8000/realtime/v1", service_role_key)
    socket = RealtimeSocket(endpoint, [f"org:{org}:soc:telemetry"])
    broadcaster = Broadcaster(socket, HttpBroadcast(endpoint, http_session))
    group.create_task(socket.run())
    await broadcaster.send([Message(f"org:{org}:soc:telemetry", "sample", sample)])

The socket joins every topic as a private channel with the service role key,
beats every 25 s, and is replaced under supervision when it closes, misses a
heartbeat reply or a channel fails. While a topic is not joined, the broadcaster
sends through Realtime's HTTP batch endpoint instead.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from enum import StrEnum

import websockets

from soc_realtime.http import HttpBroadcast
from soc_realtime.protocol import Endpoint, Message
from soc_realtime.socket import ChannelError, NotJoinedError, RealtimeSocket

__all__ = [
    "Broadcaster",
    "ChannelError",
    "Endpoint",
    "HttpBroadcast",
    "Message",
    "NotJoinedError",
    "RealtimeSocket",
    "Route",
]


class Route(StrEnum):
    SOCKET = "socket"
    HTTP = "http"
    DROPPED = "dropped"


class Broadcaster:
    def __init__(self, socket: RealtimeSocket, http: HttpBroadcast) -> None:
        self._socket = socket
        self._http = http
        self.counts: Counter[Route] = Counter()

    async def send(self, messages: Sequence[Message]) -> Route:
        unsent = list(messages)
        while unsent and self._socket.joined(unsent[0].topic):
            try:
                await self._socket.send(unsent[0])
            except NotJoinedError, OSError, websockets.exceptions.ConnectionClosed:
                break
            unsent.pop(0)
            self.counts[Route.SOCKET] += 1
        if not unsent:
            return Route.SOCKET
        route = Route.HTTP if await self._http.send(unsent) else Route.DROPPED
        self.counts[route] += len(unsent)
        return route
