"""The stacks' readings in Postgres, with SOC's migrations, and a wayline API on loopback
(FR-LNK-08, FR-LNK-09, ADR-0025).

soc-cloud's role writes the readings through its functions; each change is announced on
soc_stack_views; the flight-file address is read back; and a status read from a real
wayline API over HTTP reaches the row, and goes null once the API stops answering.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import aiohttp
import asyncpg
import pytest

import soc_config
from soc_cloud.so_api import SoApi
from soc_cloud.stacks import PostgresStackStore, StackSource, StackWatcher
from soc_cloud.testing import WAYLINE_ENVELOPE, WAYLINE_STATUS, wayline_server
from soc_database.harness import Tenancy
from soc_database.realtime import RealtimeStack
from soc_db import Database, Target

pytestmark = pytest.mark.lane

FILES = "http://soc-cloud:8090"


async def until(condition: Callable[[], bool], within_s: float = 10.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.01)


async def eventually(condition: Callable[[], Awaitable[bool]], within_s: float = 10.0) -> None:
    async with asyncio.timeout(within_s):
        while not await condition():
            await asyncio.sleep(0.01)


async def gateway_of_a_stack(admin: asyncpg.Connection, organization: uuid.UUID) -> str:
    gateway = f"SOTEST{uuid.uuid4().hex[:8].upper()}"
    await admin.execute(
        "select soc.record_stack($1, 'lab', $2, 'connected')", gateway, organization
    )
    return gateway


async def row_of(admin: asyncpg.Connection, gateway: str) -> asyncpg.Record:
    row = await admin.fetchrow(
        "select status, envelope, status_read_at, envelope_read_at, flight_files_url"
        " from soc.stacks where gateway_sn = $1",
        gateway,
    )
    assert row is not None
    return row


async def holds(
    admin: asyncpg.Connection, gateway: str, test: Callable[[asyncpg.Record], bool]
) -> bool:
    return test(await row_of(admin, gateway))


@asynccontextmanager
async def database_as_soc_cloud(
    platform: RealtimeStack, passwords: dict[str, str]
) -> AsyncIterator[Database]:
    database = Database(
        Target(
            host="127.0.0.1",
            port=platform.postgres.port,
            database="postgres",
            role="soc_cloud",
            password=passwords["soc_cloud"],
            application_name="soc-cloud-test",
        )
    )
    task = asyncio.create_task(database.run())
    try:
        await until(lambda: database.health.up)
        yield database
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_a_status_is_written_to_its_stack_and_announced_on_soc_stack_views(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    announced: list[str] = []
    try:
        organization = (await Tenancy(admin).member()).organization_id
        gateway = await gateway_of_a_stack(admin, organization)
        await admin.add_listener(
            "soc_stack_views",
            lambda _connection, _pid, _channel, payload: announced.append(payload),
        )
        async with database_as_soc_cloud(platform, passwords) as database:
            store = PostgresStackStore(database)
            await store.record_status(gateway, json.dumps(WAYLINE_STATUS))
            await eventually(lambda: holds(admin, gateway, lambda r: r["status"] is not None))
            row = await row_of(admin, gateway)
            assert json.loads(row["status"]) == WAYLINE_STATUS
            assert row["status_read_at"] is not None
            await until(lambda: gateway in announced)

            await store.record_status(gateway, None)
            await eventually(lambda: holds(admin, gateway, lambda r: r["status"] is None))
            await until(lambda: announced.count(gateway) >= 2)
    finally:
        await admin.close()


async def test_an_envelope_is_written_to_its_stack(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        organization = (await Tenancy(admin).member()).organization_id
        gateway = await gateway_of_a_stack(admin, organization)
        async with database_as_soc_cloud(platform, passwords) as database:
            await PostgresStackStore(database).record_envelope(
                gateway, json.dumps(WAYLINE_ENVELOPE)
            )
            await eventually(lambda: holds(admin, gateway, lambda r: r["envelope"] is not None))
        row = await row_of(admin, gateway)
        assert json.loads(row["envelope"]) == WAYLINE_ENVELOPE
        assert row["envelope_read_at"] is not None
    finally:
        await admin.close()


async def test_the_flight_files_address_is_recorded_for_a_known_gateway_only(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        organization = (await Tenancy(admin).member()).organization_id
        gateway = await gateway_of_a_stack(admin, organization)
        async with database_as_soc_cloud(platform, passwords) as database:
            store = PostgresStackStore(database)
            await store.record_files_url(gateway, FILES)
            assert await store.files_url(gateway) == FILES
            await store.record_files_url("UNKNOWN0001", FILES)
            assert await store.files_url("UNKNOWN0001") is None
        assert (await row_of(admin, gateway))["flight_files_url"] == FILES
    finally:
        await admin.close()


async def test_a_wayline_api_read_over_http_reaches_the_row_and_goes_null_when_it_stops(
    platform: RealtimeStack, passwords: dict[str, str]
) -> None:
    admin = await platform.postgres.connect("supabase_admin")
    try:
        organization = (await Tenancy(admin).member()).organization_id
        gateway = await gateway_of_a_stack(admin, organization)
        async with (
            wayline_server() as wayline,
            database_as_soc_cloud(platform, passwords) as database,
            aiohttp.ClientSession() as session,
        ):
            api = SoApi(session, wayline.base_url, soc_config.Secret("t" * 40), timeout_s=5.0)
            watcher = StackWatcher(
                [StackSource("lab", FILES, lambda: {gateway})],
                PostgresStackStore(database),
                status_poll_ms=100,
                envelope_poll_s=0.2,
            )
            task = asyncio.create_task(watcher.run({"lab": api}))
            try:
                await eventually(lambda: holds(admin, gateway, lambda r: r["status"] is not None))
                await eventually(lambda: holds(admin, gateway, lambda r: r["envelope"] is not None))
                await eventually(
                    lambda: holds(admin, gateway, lambda r: r["flight_files_url"] == FILES)
                )
                row = await row_of(admin, gateway)
                assert json.loads(row["status"]) == WAYLINE_STATUS
                assert json.loads(row["envelope"]) == WAYLINE_ENVELOPE

                wayline.status_code = 503
                await eventually(lambda: holds(admin, gateway, lambda r: r["status"] is None))
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
    finally:
        await admin.close()
