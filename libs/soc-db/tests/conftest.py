from __future__ import annotations

import asyncio
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import asyncpg
import pytest

from soc_database import harness
from soc_database.harness import EphemeralPostgres, migrate
from soc_db import Database, Target

Until = Callable[..., Awaitable[None]]
Running = Callable[[Database], AbstractAsyncContextManager[asyncio.Task[None]]]


async def _until(condition: Callable[[], bool], within_s: float = 1.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.001)


@asynccontextmanager
async def _running(database: Database) -> AsyncIterator[asyncio.Task[None]]:
    task = asyncio.create_task(database.run())
    try:
        yield task
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.fixture
def until() -> Until:
    return _until


@pytest.fixture
def running() -> Running:
    return _running


@pytest.fixture(scope="session")
def service_passwords() -> dict[str, str]:
    return harness.service_passwords()


@pytest.fixture(scope="session")
def postgres() -> Iterator[EphemeralPostgres]:
    database = EphemeralPostgres()
    database.start()
    try:
        yield database
    finally:
        database.stop()


@pytest.fixture(scope="session")
async def migrated(
    postgres: EphemeralPostgres, service_passwords: dict[str, str]
) -> EphemeralPostgres:
    await migrate(postgres, service_passwords)
    return postgres


@pytest.fixture
async def owner(migrated: EphemeralPostgres) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect()
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
async def superuser(migrated: EphemeralPostgres) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("supabase_admin")
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def target(migrated: EphemeralPostgres, service_passwords: dict[str, str]) -> Target:
    return Target(
        host="127.0.0.1",
        port=migrated.port,
        database="postgres",
        role="soc_cloud",
        password=service_passwords["soc_cloud"],
        application_name=f"soc-db-test-{secrets.token_hex(3)}",
    )
