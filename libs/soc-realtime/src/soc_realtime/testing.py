"""A fake of Realtime's socket, for the tests of whatever broadcasts through it."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve


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
