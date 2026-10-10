from __future__ import annotations

import secrets
from collections.abc import AsyncIterator, Iterator

import asyncpg
import pytest

from soc_database.harness import MIGRATIONS, EphemeralPostgres, Tenancy
from soc_migrate.migrations import discover
from soc_migrate.roles import SERVICE_ROLES, RolePassword
from soc_migrate.runner import Runner


@pytest.fixture(scope="session")
def service_passwords() -> dict[str, str]:
    return {role: secrets.token_hex(20) for role in SERVICE_ROLES}


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
    connection = await postgres.connect()
    try:
        passwords = [RolePassword(role, value) for role, value in service_passwords.items()]
        await Runner(connection).run(discover(MIGRATIONS), passwords)
    finally:
        await connection.close()
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
