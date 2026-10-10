from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest

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
