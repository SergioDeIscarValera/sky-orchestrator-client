from __future__ import annotations

import asyncio
import functools
import secrets
import socket
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator

import aiohttp
import aiohttp.abc
import asyncpg
import pytest
import websockets

from soc_database.harness import MIGRATIONS, Tenancy
from soc_database.realtime import RealtimeStack
from soc_migrate.migrations import discover
from soc_migrate.roles import SERVICE_ROLES, ServiceCredential
from soc_migrate.runner import Runner
from soc_realtime.socket import Connector
from soc_realtime.testing import FakePhoenix

Until = Callable[..., Awaitable[None]]


async def _until(condition: Callable[[], object], within_s: float = 2.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.002)


@pytest.fixture
def until() -> Until:
    return _until


@pytest.fixture
async def phoenix() -> AsyncIterator[FakePhoenix]:
    async with FakePhoenix().serving() as fake:
        yield fake


class PinnedResolver(aiohttp.abc.AbstractResolver):
    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[aiohttp.abc.ResolveResult]:
        return [
            {
                "hostname": host,
                "host": "127.0.0.1",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": socket.AI_NUMERICHOST,
            }
        ]

    async def close(self) -> None:
        pass


@pytest.fixture(scope="session")
def stack() -> Iterator[RealtimeStack]:
    realtime = RealtimeStack()
    realtime.start()
    try:
        yield realtime
    finally:
        realtime.stop()


@pytest.fixture(scope="session")
async def migrated(stack: RealtimeStack) -> RealtimeStack:
    connection = await stack.postgres.connect()
    try:
        credentials = [ServiceCredential(role, secrets.token_hex(20)) for role in SERVICE_ROLES]
        await Runner(connection).run(discover(MIGRATIONS), credentials)
    finally:
        await connection.close()
    return stack


@pytest.fixture
async def tenancy(migrated: RealtimeStack) -> AsyncIterator[Tenancy]:
    connection = await migrated.postgres.connect("supabase_admin")
    try:
        yield Tenancy(connection)
    finally:
        await connection.close()


@pytest.fixture
async def owner(migrated: RealtimeStack) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.postgres.connect()
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def connector(stack: RealtimeStack) -> Connector:
    return functools.partial(websockets.connect, host="127.0.0.1", port=stack.port)


@pytest.fixture
async def http_session() -> AsyncIterator[aiohttp.ClientSession]:
    connector = aiohttp.TCPConnector(resolver=PinnedResolver())
    async with aiohttp.ClientSession(connector=connector) as session:
        yield session
