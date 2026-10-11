from __future__ import annotations

import asyncio
import itertools
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

import soc_log
from soc_realtime.protocol import (
    CHANNEL_FAILURES,
    REPLY,
    TOPIC_PREFIX,
    Endpoint,
    Frame,
    Message,
    broadcast,
    decode,
    encode,
    heartbeat,
    join,
)
from soc_supervision import Backoff, Health, Supervisor

HEARTBEAT_S = 25.0
REPLY_TIMEOUT_S = 10.0
CLOSE_TIMEOUT_S = 2.0
MAX_FRAME_BYTES = 1 << 20

Connector = Callable[..., Awaitable[ClientConnection]]

log = soc_log.get(__name__)


class ChannelError(Exception):
    pass


class NotJoinedError(Exception):
    pass


TRANSIENT = (OSError, TimeoutError, websockets.exceptions.WebSocketException, ChannelError)


class RealtimeSocket:
    def __init__(
        self,
        endpoint: Endpoint,
        topics: Iterable[str],
        *,
        connector: Connector = websockets.connect,
        heartbeat_s: float = HEARTBEAT_S,
        reply_timeout_s: float = REPLY_TIMEOUT_S,
        backoff: Backoff | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._endpoint = endpoint
        self._topics = tuple(dict.fromkeys(topics))
        self._connector = connector
        self._heartbeat_s = heartbeat_s
        self._reply_timeout_s = reply_timeout_s
        self._refs = itertools.count(1)
        self._socket: ClientConnection | None = None
        self._joined: dict[str, str] = {}
        self._replies: dict[str, asyncio.Future[Frame]] = {}
        self._supervisor = Supervisor(
            "realtime",
            connect=self._open,
            serve=self._serve,
            disconnect=self._close,
            transient=TRANSIENT,
            backoff=backoff,
            sleep=sleep,
        )

    @property
    def health(self) -> Health:
        return self._supervisor.health

    def joined(self, topic: str) -> bool:
        return topic in self._joined

    async def run(self) -> None:
        await self._supervisor.run()

    async def send(self, message: Message) -> None:
        socket = self._socket
        join_ref = self._joined.get(message.topic)
        if socket is None or join_ref is None:
            raise NotJoinedError(message.topic)
        await socket.send(encode(broadcast(message, self._ref(), join_ref)))

    def _ref(self) -> str:
        return str(next(self._refs))

    async def _open(self) -> ClientConnection:
        socket = await self._connector(
            self._endpoint.websocket_url(),
            open_timeout=self._reply_timeout_s,
            close_timeout=CLOSE_TIMEOUT_S,
            ping_interval=None,
            max_size=MAX_FRAME_BYTES,
        )
        try:
            joined = {topic: await self._join(socket, topic) for topic in self._topics}
        except BaseException:
            await socket.close()
            raise
        self._socket = socket
        self._joined = joined
        return socket

    async def _join(self, socket: ClientConnection, topic: str) -> str:
        ref = self._ref()
        await socket.send(encode(join(topic, ref, self._endpoint.key)))
        async with asyncio.timeout(self._reply_timeout_s):
            while True:
                frame = decode(await socket.recv())
                if frame.event == REPLY and frame.ref == ref:
                    break
        if frame.payload.get("status") != "ok":
            raise ChannelError(f"joining {topic} was refused: {_reason(frame.payload)}")
        return ref

    async def _serve(self, socket: ClientConnection) -> None:
        async with asyncio.TaskGroup() as group:
            beating = group.create_task(self._beat(socket))
            await self._read(socket)
            beating.cancel()

    async def _read(self, socket: ClientConnection) -> None:
        async for text in socket:
            frame = decode(text)
            if frame.event == REPLY and frame.ref in self._replies:
                self._replies.pop(frame.ref).set_result(frame)
            elif frame.event in CHANNEL_FAILURES and _subtopic(frame.topic) in self._joined:
                raise ChannelError(f"{_subtopic(frame.topic)} received {frame.event}")
            elif frame.event == "system" and frame.payload.get("status") == "error":
                log.warning("realtime_system_error", topic=frame.topic, detail=frame.payload)

    async def _beat(self, socket: ClientConnection) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(self._heartbeat_s)
            ref = self._ref()
            reply = self._replies[ref] = loop.create_future()
            await socket.send(encode(heartbeat(ref)))
            try:
                await asyncio.wait_for(reply, self._reply_timeout_s)
            except TimeoutError:
                raise TimeoutError("no heartbeat reply") from None

    async def _close(self, socket: ClientConnection) -> None:
        self._socket = None
        self._joined = {}
        for reply in self._replies.values():
            reply.cancel()
        self._replies.clear()
        await socket.close()


def _subtopic(topic: str) -> str:
    return topic.removeprefix(TOPIC_PREFIX)


def _reason(payload: dict[str, Any]) -> str:
    response = payload.get("response")
    if isinstance(response, dict) and "reason" in response:
        return str(response["reason"])
    return str(payload.get("status", "no status"))
