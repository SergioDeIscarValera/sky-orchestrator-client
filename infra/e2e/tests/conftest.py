from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import asyncpg
import pytest

from soc_check import Image
from soc_cloud.testing import EphemeralMosquitto
from soc_database.harness import service_passwords
from soc_e2e.platform import Platform


@pytest.fixture(scope="session")
def passwords() -> dict[str, str]:
    return service_passwords()


@pytest.fixture(scope="session")
async def platform(passwords: dict[str, str]) -> AsyncIterator[Platform]:
    started = Platform()
    await started.start(passwords)
    try:
        yield started
    finally:
        started.stop()


@pytest.fixture(scope="session")
def broker() -> Iterator[EphemeralMosquitto]:
    mosquitto = EphemeralMosquitto()
    mosquitto.start()
    try:
        yield mosquitto
    finally:
        mosquitto.stop()


@pytest.fixture(scope="session")
def console_image() -> Iterator[Image]:
    image = Image("soc-web")
    image.build()
    try:
        yield image
    finally:
        image.remove()


@pytest.fixture
async def admin(platform: Platform) -> AsyncIterator[asyncpg.Connection]:
    """A connection as supabase_admin, which the flights' tests read and write through."""
    connection = await platform.stack.postgres.connect("supabase_admin")
    try:
        yield connection
    finally:
        await connection.close()
