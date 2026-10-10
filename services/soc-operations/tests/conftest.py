from __future__ import annotations

from collections.abc import Iterator

import pytest

from soc_database.harness import EphemeralPostgres, migrate, service_passwords


@pytest.fixture(scope="session")
def passwords() -> dict[str, str]:
    return service_passwords()


@pytest.fixture(scope="session")
def postgres() -> Iterator[EphemeralPostgres]:
    database = EphemeralPostgres()
    database.start()
    try:
        yield database
    finally:
        database.stop()


@pytest.fixture(scope="session")
async def migrated(postgres: EphemeralPostgres, passwords: dict[str, str]) -> EphemeralPostgres:
    await migrate(postgres, passwords)
    return postgres
