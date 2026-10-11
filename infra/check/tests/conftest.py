from __future__ import annotations

from collections.abc import Iterator

import pytest

from soc_check import Image
from soc_database.harness import EphemeralPostgres, migrate, service_passwords


@pytest.fixture(scope="session")
def images() -> Iterator[dict[str, Image]]:
    services = ("soc-cloud", "soc-operations", "soc-migrate", "soc-web")
    built = {service: Image(service) for service in services}
    try:
        for image in built.values():
            image.build()
        yield built
    finally:
        for image in built.values():
            image.remove()


@pytest.fixture(scope="session")
def passwords() -> dict[str, str]:
    return service_passwords()


@pytest.fixture
def postgres() -> Iterator[EphemeralPostgres]:
    database = EphemeralPostgres()
    database.start()
    try:
        yield database
    finally:
        database.stop()


@pytest.fixture
async def migrated(postgres: EphemeralPostgres, passwords: dict[str, str]) -> EphemeralPostgres:
    await migrate(postgres, passwords)
    return postgres
