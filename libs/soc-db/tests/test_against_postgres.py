from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import replace

import asyncpg
import pytest

from soc_db import Backoff, Database, Target

pytestmark = pytest.mark.database

Until = Callable[..., Awaitable[None]]
Running = Callable[[Database], AbstractAsyncContextManager[asyncio.Task[None]]]


async def test_the_service_role_connects_with_its_settings(
    target: Target, running: Running
) -> None:
    database = Database(target)
    async with running(database), database.session() as connection:
        row = await connection.fetchrow(
            "select current_user as role,"
            " current_setting('application_name') as application_name,"
            " current_setting('tcp_keepalives_idle') as keepalives_idle,"
            " current_setting('statement_timeout') as statement_timeout"
        )
    assert row is not None
    assert dict(row) == {
        "role": "soc_cloud",
        "application_name": target.application_name,
        "keepalives_idle": "10",
        "statement_timeout": "5s",
    }


async def test_a_wrong_password_keeps_it_down_and_says_why(
    target: Target, running: Running, until: Until
) -> None:
    database = Database(replace(target, password="w" * 40), backoff=Backoff(initial_s=0.05))
    async with running(database):
        await until(lambda: database.health.error != "not connected yet", 5)
    assert not database.health.up
    assert database.health.error is not None
    assert "InvalidPasswordError" in database.health.error


async def test_a_notification_arrives_only_once_its_transaction_commits(
    target: Target, owner: asyncpg.Connection, running: Running, until: Until
) -> None:
    received: list[str] = []

    async def handle(payload: str) -> None:
        received.append(payload)

    database = Database(target, listeners={"soc_probe": handle})
    async with running(database):
        await until(lambda: database.health.up, 5)
        rolled_back = owner.transaction()
        await rolled_back.start()
        await owner.execute("select pg_notify('soc_probe', 'rolled back')")
        await rolled_back.rollback()
        await owner.execute("select pg_notify('soc_probe', 'committed')")
        await until(lambda: received, 5)
    assert received == ["committed"]


async def test_a_terminated_backend_is_replaced_listened_and_swept_again(
    target: Target,
    owner: asyncpg.Connection,
    superuser: asyncpg.Connection,
    running: Running,
    until: Until,
) -> None:
    sweeps: list[int] = []
    received: list[str] = []

    async def sweep() -> None:
        async with database.session() as connection:
            sweeps.append(await connection.fetchval("select pg_backend_pid()"))

    async def handle(payload: str) -> None:
        received.append(payload)

    database = Database(
        target,
        listeners={"soc_probe": handle},
        on_connected=sweep,
        backoff=Backoff(initial_s=0.05),
    )
    async with running(database):
        await until(lambda: len(sweeps) == 1, 5)
        terminated = await superuser.fetchval(
            "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1",
            target.application_name,
        )
        assert terminated is True
        await until(lambda: len(sweeps) == 2, 10)
        await owner.execute("select pg_notify('soc_probe', 'after the reconnection')")
        await until(lambda: received, 5)
    assert sweeps[0] != sweeps[1]
    assert received == ["after the reconnection"]


async def test_records_are_copied_into_a_soc_table(
    target: Target, owner: asyncpg.Connection, running: Running
) -> None:
    await owner.execute("create table soc.copy_probe (id integer primary key, label text not null)")
    await owner.execute("grant insert on soc.copy_probe to soc_cloud")
    try:
        database = Database(target)
        async with running(database):
            await database.copy_records("copy_probe", [(1, "a"), (2, "b")], ("id", "label"))
        rows = await owner.fetch("select id, label from soc.copy_probe order by id")
        assert [tuple(row) for row in rows] == [(1, "a"), (2, "b")]
    finally:
        await owner.execute("drop table soc.copy_probe")
