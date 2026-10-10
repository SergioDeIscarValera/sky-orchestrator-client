from __future__ import annotations

import functools
from collections.abc import Iterator

import pytest
import websockets

from soc_database.harness import migrate, service_passwords
from soc_database.realtime import RealtimeStack
from soc_realtime.socket import Connector


@pytest.fixture(scope="session")
def passwords() -> dict[str, str]:
    return service_passwords()


@pytest.fixture(scope="session")
def stack() -> Iterator[RealtimeStack]:
    platform = RealtimeStack()
    platform.start()
    try:
        yield platform
    finally:
        platform.stop()


@pytest.fixture(scope="session")
async def platform(stack: RealtimeStack, passwords: dict[str, str]) -> RealtimeStack:
    await migrate(stack.postgres, passwords)
    return stack


@pytest.fixture
def connector(stack: RealtimeStack) -> Connector:
    return functools.partial(websockets.connect, host="127.0.0.1", port=stack.port)
