from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import asyncpg
import pytest

from soc_database import harness
from soc_database.harness import EphemeralPostgres, Tenancy, migrate


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
async def admin(migrated: EphemeralPostgres) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("supabase_admin")
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
async def session(migrated: EphemeralPostgres) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect()
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def tenancy(admin: asyncpg.Connection) -> Tenancy:
    return Tenancy(admin)


@pytest.fixture(scope="session")
async def todays_partition(migrated: EphemeralPostgres) -> AsyncIterator[None]:
    connection = await migrated.connect("supabase_admin")
    try:
        await connection.execute(
            "create table if not exists realtime.messages_soc_tests "
            "partition of realtime.messages "
            "for values from (now() - interval '2 days') to (now() + interval '2 days')"
        )
        yield
    finally:
        await connection.close()
