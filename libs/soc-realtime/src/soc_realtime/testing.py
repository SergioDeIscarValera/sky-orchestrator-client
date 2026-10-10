"""Test doubles: a fake of Realtime's socket, and a member's browser on a real one."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

import websockets
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.server import ServerConnection, serve

from soc_realtime.protocol import (
    BROADCAST,
    REPLY,
    Endpoint,
    Message,
    broadcast,
    decode,
    encode,
    join,
)
from soc_realtime.socket import Connector


class FakePhoenix:
    """Realtime's socket as SOC uses it: joins, heartbeats, broadcasts, failures on demand."""

    def __init__(self) -> None:
        self.connections: list[ServerConnection] = []
        self.queries: list[dict[str, list[str]]] = []
        self.joins: list[dict[str, Any]] = []
        self.broadcasts: list[dict[str, Any]] = []
        self.heartbeats = 0
        self.refused_topics: set[str] = set()
        self.answer_heartbeats = True
        self.port = 0

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}/socket"

    @asynccontextmanager
    async def serving(self) -> AsyncIterator[FakePhoenix]:
        async with serve(self.handle, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            yield self

    async def handle(self, connection: ServerConnection) -> None:
        self.connections.append(connection)
        path = connection.request.path if connection.request is not None else ""
        self.queries.append(parse_qs(urlsplit(path).query))
        async for text in connection:
            frame = json.loads(text)
            if frame["event"] == "phx_join":
                self.joins.append(frame)
                status = "error" if frame["topic"] in self.refused_topics else "ok"
                response = {"reason": "Unauthorized"} if status == "error" else {}
                await self.reply(connection, frame, status, response)
            elif frame["event"] == "heartbeat":
                self.heartbeats += 1
                if self.answer_heartbeats:
                    await self.reply(connection, frame, "ok", {})
            elif frame["event"] == "broadcast":
                self.broadcasts.append(frame)

    @staticmethod
    async def reply(
        connection: ServerConnection, frame: dict[str, Any], status: str, response: dict[str, Any]
    ) -> None:
        await connection.send(
            json.dumps(
                {
                    "topic": frame["topic"],
                    "event": "phx_reply",
                    "payload": {"status": status, "response": response},
                    "ref": frame["ref"],
                    "join_ref": frame.get("join_ref"),
                }
            )
        )

    async def push(self, topic: str, event: str, payload: dict[str, Any]) -> None:
        frame = {"topic": topic, "event": event, "payload": payload, "ref": None}
        await self.connections[-1].send(json.dumps(frame))


class Subscriber:
    """A member's browser on one private topic: joins with its token, then collects broadcasts."""

    def __init__(
        self, base: str, token: str, topic: str, connector: Connector = websockets.connect
    ) -> None:
        self._url = Endpoint(base, token).websocket_url()
        self._token = token
        self._topic = topic
        self._connector = connector
        self._received: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._socket: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self.joined = False
        self.reason = ""

    async def __aenter__(self) -> Subscriber:
        self._socket = await self._connector(self._url, ping_interval=None)
        await self._socket.send(encode(join(self._topic, "1", self._token)))
        async with asyncio.timeout(10):
            while True:
                frame = decode(await self._socket.recv())
                if frame.event == REPLY and frame.ref == "1":
                    break
        self.joined = frame.payload.get("status") == "ok"
        self.reason = str(frame.payload.get("response", {}).get("reason", ""))
        self._reader = asyncio.create_task(self._read(self._socket))
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._reader is not None:
            self._reader.cancel()
        if self._socket is not None:
            await self._socket.close()

    async def broadcast(self, within_s: float = 5.0) -> dict[str, Any]:
        return await asyncio.wait_for(self._received.get(), within_s)

    async def silent_for(self, seconds: float) -> bool:
        try:
            await asyncio.wait_for(self._received.get(), seconds)
        except TimeoutError:
            return True
        return False

    async def send(self, event: str, payload: dict[str, Any]) -> None:
        assert self._socket is not None
        message = Message(self._topic, event, payload)
        await self._socket.send(encode(broadcast(message, "2", "1")))

    async def _read(self, socket: ClientConnection) -> None:
        async for text in socket:
            frame = decode(text)
            if frame.event == BROADCAST:
                self._received.put_nowait(frame.payload)
