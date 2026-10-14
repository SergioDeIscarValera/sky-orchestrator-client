from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any, cast

import asyncpg
import pytest

from soc_db import Database, DatabaseUnavailableError, Target

Until = Callable[..., Awaitable[None]]
Running = Callable[[Database], AbstractAsyncContextManager[asyncio.Task[None]]]

TARGET = Target(
    host="db",
    port=5432,
    database="postgres",
    role="soc_cloud",
    password="p" * 40,
    application_name="soc-cloud",
)


class FakeConnection:
    def __init__(self, journal: list[str]) -> None:
        self.journal = journal
        self.listeners: dict[str, Callable[..., None]] = {}
        self.termination: list[Callable[[object], None]] = []
        self.closed = False
        self.ping_error: BaseException | None = None

    async def add_listener(self, channel: str, callback: Callable[..., None]) -> None:
        self.journal.append(f"listen {channel}")
        self.listeners[channel] = callback

    def add_termination_listener(self, callback: Callable[[object], None]) -> None:
        self.termination.append(callback)

    async def fetchval(self, query: str, **_: object) -> int:
        if self.ping_error is not None:
            raise self.ping_error
        return 1

    def is_closed(self) -> bool:
        return self.closed

    def terminate(self) -> None:
        self.closed = True

    def drop(self) -> None:
        self.closed = True
        for callback in self.termination:
            callback(self)

    def notify(self, channel: str, payload: str) -> None:
        self.listeners[channel](self, 4242, channel, payload)


class FakeServer:
    def __init__(self, *outcomes: BaseException | None) -> None:
        self.outcomes = list(outcomes)
        self.journal: list[str] = []
        self.connections: list[FakeConnection] = []
        self.arguments: list[dict[str, Any]] = []
        self.sleeps: list[float] = []
        self.refusing: BaseException | None = None

    async def connect(self, **arguments: Any) -> asyncpg.Connection:
        self.arguments.append(arguments)
        outcome = self.outcomes.pop(0) if self.outcomes else self.refusing
        if outcome is not None:
            raise outcome
        connection = FakeConnection(self.journal)
        self.connections.append(connection)
        return cast(asyncpg.Connection, connection)

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        await asyncio.sleep(0)


def database_on(server: FakeServer, **options: Any) -> Database:
    return Database(TARGET, connector=server.connect, sleep=server.sleep, **options)


def test_the_password_never_shows() -> None:
    assert "p" * 40 not in repr(TARGET)


def test_the_connection_names_itself_and_keeps_the_server_probing_it() -> None:
    arguments = TARGET.connect_arguments()
    assert arguments["user"] == "soc_cloud"
    assert arguments["timeout"] == 5.0
    assert arguments["server_settings"] == {
        "application_name": "soc-cloud",
        "tcp_keepalives_idle": "10",
        "tcp_keepalives_interval": "5",
        "tcp_keepalives_count": "3",
    }


async def test_it_listens_on_every_channel_before_the_sweep(running: Running, until: Until) -> None:
    server = FakeServer()

    async def sweep() -> None:
        server.journal.append("sweep")

    async def ignore(_: str) -> None:
        pass

    database = database_on(server, listeners={"a": ignore, "b": ignore}, on_connected=sweep)
    async with running(database):
        await until(lambda: "sweep" in server.journal)
    assert server.journal == ["listen a", "listen b", "sweep"]


async def test_failed_connections_are_retried_with_backoff(running: Running, until: Until) -> None:
    server = FakeServer(OSError("refused"), asyncpg.InvalidPasswordError("no"), None)
    database = database_on(server)
    async with running(database):
        await until(lambda: database.health.up)
    assert server.sleeps == [0.5, 1.0]


async def test_health_says_why_it_is_down(running: Running, until: Until) -> None:
    server = FakeServer()
    server.refusing = OSError("connection refused")
    database = database_on(server)
    assert database.health.error == "not connected yet"
    async with running(database):
        await until(lambda: len(server.sleeps) >= 2)
        assert not database.health.up
        assert database.health.error == "OSError: connection refused"


async def test_a_lost_connection_is_replaced_and_swept_again(
    running: Running, until: Until
) -> None:
    server = FakeServer()
    sweeps: list[int] = []

    async def sweep() -> None:
        sweeps.append(len(server.connections))

    database = database_on(server, on_connected=sweep)
    async with running(database):
        await until(lambda: sweeps == [1])
        server.connections[0].drop()
        await until(lambda: sweeps == [1, 2])
    assert server.sleeps == [0.5]
    assert database.health.up


async def test_a_failed_ping_replaces_the_connection(running: Running, until: Until) -> None:
    server = FakeServer()
    database = database_on(server, ping_interval_s=0.001)
    async with running(database):
        await until(lambda: database.health.up)
        server.connections[0].ping_error = TimeoutError()
        await until(lambda: len(server.connections) == 2)
    assert server.connections[0].closed


async def test_notifications_reach_their_handler_in_order_despite_a_failure(
    running: Running, until: Until
) -> None:
    server = FakeServer()
    received: list[str] = []

    async def handle(payload: str) -> None:
        if payload == "boom":
            raise RuntimeError("handler bug")
        received.append(payload)

    database = database_on(server, listeners={"soc_intents": handle})
    async with running(database):
        await until(lambda: database.health.up)
        for payload in ("1", "boom", "2", "3"):
            server.connections[0].notify("soc_intents", payload)
        await until(lambda: len(received) == 3)
    assert received == ["1", "2", "3"]


async def test_a_session_waits_for_the_connection(running: Running) -> None:
    server = FakeServer(OSError("not yet"))
    database = database_on(server)
    async with running(database), database.session() as connection:
        assert connection is cast(asyncpg.Connection, server.connections[0])


async def test_a_session_without_a_connection_is_refused() -> None:
    database = database_on(FakeServer())
    with pytest.raises(DatabaseUnavailableError, match=r"within 0\.01 s"):
        async with database.session(wait_s=0.01):
            pass


async def test_sessions_take_turns_on_the_one_connection(running: Running) -> None:
    server = FakeServer()
    database = database_on(server)
    inside = 0
    most = 0

    async def statement() -> None:
        nonlocal inside, most
        async with database.session():
            inside += 1
            most = max(most, inside)
            await asyncio.sleep(0.001)
            inside -= 1

    async with running(database):
        await asyncio.gather(*(statement() for _ in range(5)))
    assert most == 1


async def test_a_session_on_a_connection_just_lost_is_refused(
    running: Running, until: Until
) -> None:
    server = FakeServer()
    database = database_on(server)
    async with running(database):
        await until(lambda: database.health.up)
        server.connections[0].closed = True
        with pytest.raises(DatabaseUnavailableError, match="lost"):
            async with database.session():
                pass


async def test_a_sweep_that_loses_its_connection_is_run_again_on_a_new_one(
    running: Running, until: Until
) -> None:
    server = FakeServer()
    sweeps: list[int] = []

    async def sweep() -> None:
        sweeps.append(len(server.connections))
        if len(sweeps) == 1:
            server.connections[0].closed = True
            async with database.session():
                pass

    database = database_on(server, on_connected=sweep)
    async with running(database):
        await until(lambda: sweeps == [1, 2])
        await until(lambda: database.health.up)
    assert server.connections[0].closed


async def test_a_bug_in_the_sweep_stops_the_service() -> None:
    async def broken_sweep() -> None:
        raise ValueError("sweep bug")

    database = database_on(FakeServer(), on_connected=broken_sweep)
    with pytest.raises(ExceptionGroup) as stopped:
        await asyncio.wait_for(database.run(), 1)
    assert stopped.group_contains(ValueError, match="sweep bug")
