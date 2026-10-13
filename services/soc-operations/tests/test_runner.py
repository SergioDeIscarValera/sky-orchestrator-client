"""The runner's tick survives the database going away under it (soc_operations.runner).

A connection lost in the middle of the tick's query used to end the tick, and with it the
service; the tick now logs it and tries again on the next one, as the worker does for a job.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import asyncpg
import pytest
from structlog.testing import capture_logs

from soc_config import Contract
from soc_db import DatabaseUnavailableError
from soc_operations import settings
from soc_operations.runner import JudgeOperation, Runner

OPERATION = uuid.uuid4()


class Connection:
    async def fetch(self, *_arguments: Any) -> list[dict[str, Any]]:
        return [{"id": OPERATION}]


class FlakyDatabase:
    """A session that fails as `failures` say, in turn, then answers."""

    def __init__(self, *failures: BaseException) -> None:
        self.failures = list(failures)
        self.sessions = 0

    @asynccontextmanager
    async def session(self) -> AsyncIterator[Connection]:
        self.sessions += 1
        if self.failures:
            raise self.failures.pop(0)
        yield Connection()


def runner(tmp_path: Path) -> Runner:
    path = tmp_path / "soc-operations.json"
    values = {
        **Contract.read().starting_file(settings.SERVICE),
        "served_organizations": ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"],
    }
    path.write_text(json.dumps(values), encoding="utf-8")
    loaded = settings.load(
        {
            "SOC_CONFIG_FILE": str(path),
            "SOC_HEALTH_PORT": "8081",
            "SOC_DB_HOST": "db",
            "SOC_DB_PORT": "5432",
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_OPERATIONS": "k" * 20 + "7" * 20,
        }
    )
    return Runner(loaded.database, loaded.tunables, lambda *_: (), tick_s=0.001)


@pytest.mark.parametrize(
    "lost",
    [
        DatabaseUnavailableError("no connection within 5 s"),
        asyncpg.ConnectionDoesNotExistError("connection was closed in the middle of operation"),
        asyncpg.InterfaceError("cannot perform operation: another operation is in progress"),
        ConnectionResetError("reset by peer"),
    ],
    ids=["away", "closed-midway", "interface", "reset"],
)
async def test_a_tick_that_loses_its_connection_tries_again_on_the_next(
    lost: BaseException, tmp_path: Path
) -> None:
    ticking = runner(tmp_path)
    database = FlakyDatabase(lost, lost)
    ticking.database = database  # type: ignore[assignment]
    with capture_logs() as logs:
        task = asyncio.create_task(ticking._tick())
        try:
            async with asyncio.timeout(2):
                while ticking._jobs.empty():
                    await asyncio.sleep(0.001)
            assert not task.done()
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    assert ticking._jobs.get_nowait() == JudgeOperation(OPERATION)
    assert database.sessions >= 3
    assert [entry["event"] for entry in logs].count("tick_missed") == 2
