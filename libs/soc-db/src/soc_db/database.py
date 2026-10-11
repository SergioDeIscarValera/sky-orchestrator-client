from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import asyncpg

import soc_log
from soc_supervision import Backoff, Health, Supervisor

CONNECT_TIMEOUT_S = 5.0
PING_INTERVAL_S = 15.0
PING_TIMEOUT_S = 5.0
SESSION_WAIT_S = 5.0
KEEPALIVES = {
    "tcp_keepalives_idle": "10",
    "tcp_keepalives_interval": "5",
    "tcp_keepalives_count": "3",
}
CONNECTION_ERRORS = (OSError, TimeoutError, asyncpg.PostgresError, asyncpg.InterfaceError)

NotificationHandler = Callable[[str], Awaitable[None]]
Connector = Callable[..., Awaitable[asyncpg.Connection]]

log = soc_log.get(__name__)


class DatabaseUnavailableError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    database: str
    role: str
    password: str = field(repr=False)
    application_name: str

    def connect_arguments(self) -> dict[str, Any]:
        return {
            "host": self.host,
            "port": self.port,
            "database": self.database,
            "user": self.role,
            "password": self.password,
            "timeout": CONNECT_TIMEOUT_S,
            "server_settings": {"application_name": self.application_name, **KEEPALIVES},
        }


class Database:
    def __init__(
        self,
        target: Target,
        *,
        listeners: Mapping[str, NotificationHandler] | None = None,
        on_connected: Callable[[], Awaitable[None]] | None = None,
        connector: Connector = asyncpg.connect,
        backoff: Backoff | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        ping_interval_s: float = PING_INTERVAL_S,
    ) -> None:
        self._target = target
        self._listeners = dict(listeners or {})
        self._on_connected = on_connected
        self._connector = connector
        self._ping_interval_s = ping_interval_s
        self._connection: asyncpg.Connection | None = None
        self._connected = asyncio.Event()
        self._lost = asyncio.Event()
        self._lock = asyncio.Lock()
        self._notifications: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._supervisor = Supervisor(
            "database",
            connect=self._open,
            serve=self._serve,
            disconnect=self._close,
            transient=CONNECTION_ERRORS,
            backoff=backoff,
            sleep=sleep,
        )

    @property
    def health(self) -> Health:
        return self._supervisor.health

    async def run(self) -> None:
        async with asyncio.TaskGroup() as group:
            group.create_task(self._dispatch_notifications())
            group.create_task(self._supervisor.run())

    @asynccontextmanager
    async def session(self, wait_s: float = SESSION_WAIT_S) -> AsyncIterator[asyncpg.Connection]:
        try:
            await asyncio.wait_for(self._connected.wait(), wait_s)
        except TimeoutError:
            raise DatabaseUnavailableError(f"no connection within {wait_s} s") from None
        async with self._lock:
            connection = self._connection
            if connection is None or connection.is_closed():
                raise DatabaseUnavailableError("the connection was lost")
            yield connection

    @asynccontextmanager
    async def transaction(
        self, wait_s: float = SESSION_WAIT_S
    ) -> AsyncIterator[asyncpg.Connection]:
        async with self.session(wait_s) as connection, connection.transaction():
            yield connection

    async def copy_records(
        self,
        table: str,
        records: Iterable[Sequence[object]],
        columns: Sequence[str],
        schema: str = "soc",
    ) -> None:
        async with self.session() as connection:
            await connection.copy_records_to_table(
                table, records=records, columns=columns, schema_name=schema
            )

    async def _open(self) -> asyncpg.Connection:
        connection = await self._connector(**self._target.connect_arguments())
        lost = asyncio.Event()
        try:
            connection.add_termination_listener(lambda _: lost.set())
            for channel in self._listeners:
                await connection.add_listener(channel, self._enqueue)
        except BaseException:
            connection.terminate()
            raise
        self._lost = lost
        self._connection = connection
        self._connected.set()
        return connection

    async def _serve(self, connection: asyncpg.Connection) -> None:
        if self._on_connected is not None:
            await self._on_connected()
        while not self._lost.is_set():
            try:
                await asyncio.wait_for(self._lost.wait(), self._ping_interval_s)
            except TimeoutError:
                async with self._lock:
                    await connection.fetchval("select 1", timeout=PING_TIMEOUT_S)

    async def _close(self, connection: asyncpg.Connection) -> None:
        self._connection = None
        self._connected.clear()
        if not connection.is_closed():
            connection.terminate()

    def _enqueue(self, _connection: object, _pid: int, channel: str, payload: object) -> None:
        self._notifications.put_nowait((channel, str(payload)))

    async def _dispatch_notifications(self) -> None:
        while True:
            channel, payload = await self._notifications.get()
            try:
                await self._listeners[channel](payload)
            except Exception:
                log.exception("notification_handler_failed", channel=channel)
