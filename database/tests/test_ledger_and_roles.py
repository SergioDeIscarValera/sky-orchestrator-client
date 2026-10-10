from __future__ import annotations

import asyncio

import asyncpg
import pytest

from soc_database.harness import MIGRATIONS, EphemeralPostgres, acting_as
from soc_migrate.migrations import Migration, MigrationError, discover
from soc_migrate.runner import LOCK_KEY, Runner


async def test_every_migration_is_in_the_ledger(session: asyncpg.Connection) -> None:
    rows = await session.fetch("select version, name, sha256 from soc_migrations.applied")
    expected = {(m.version, m.name, m.sha256) for m in discover(MIGRATIONS)}
    assert {(row["version"], row["name"], row["sha256"]) for row in rows} == expected


async def test_a_second_run_applies_nothing(session: asyncpg.Connection) -> None:
    result = await Runner(session).run(discover(MIGRATIONS), [])
    assert result.pending == ()


async def test_an_edited_migration_stops_the_runner(session: asyncpg.Connection) -> None:
    first, *rest = discover(MIGRATIONS)
    edited = [Migration(first.version, first.name, first.sql + "\n-- edited\n"), *rest]
    with pytest.raises(MigrationError, match="was edited after it was applied"):
        await Runner(session).run(edited, [])


async def test_a_runner_waits_for_the_one_holding_the_lock(
    migrated: EphemeralPostgres, session: asyncpg.Connection
) -> None:
    holder = await migrated.connect()
    try:
        await holder.execute("select pg_advisory_lock(hashtext($1))", LOCK_KEY)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(Runner(session).run(discover(MIGRATIONS), []), timeout=1)
    finally:
        await holder.close()


@pytest.mark.parametrize("role", ["soc_cloud", "soc_operations"])
async def test_a_service_role_logs_in_with_its_password_and_its_limits(
    migrated: EphemeralPostgres, service_passwords: dict[str, str], role: str
) -> None:
    connection = await migrated.connect(role, service_passwords[role])
    try:
        row = await connection.fetchrow(
            "select current_user, current_setting('statement_timeout') as statement, "
            "current_setting('lock_timeout') as lock"
        )
        assert row is not None
        assert (row["current_user"], row["statement"], row["lock"]) == (role, "5s", "2s")
    finally:
        await connection.close()


async def test_a_wrong_password_is_refused(migrated: EphemeralPostgres) -> None:
    with pytest.raises(asyncpg.InvalidPasswordError):
        await migrated.connect("soc_cloud", "not-the-password")


async def test_passwords_are_stored_as_scram_verifiers_only(
    admin: asyncpg.Connection, service_passwords: dict[str, str]
) -> None:
    rows = await admin.fetch(
        "select rolname, rolpassword from pg_authid where rolname = any($1::text[])",
        list(service_passwords),
    )
    for row in rows:
        assert row["rolpassword"].startswith("SCRAM-SHA-256$4096:")
        assert service_passwords[row["rolname"]] not in row["rolpassword"]


async def test_service_roles_hold_no_dangerous_attribute(admin: asyncpg.Connection) -> None:
    rows = await admin.fetch(
        "select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconnlimit "
        "from pg_roles where rolname in ('soc_cloud', 'soc_operations')"
    )
    assert len(rows) == 2
    for row in rows:
        assert not (row["rolsuper"] or row["rolcreaterole"] or row["rolcreatedb"])
        assert not row["rolbypassrls"]
        assert row["rolconnlimit"] == 3


async def test_a_service_role_cannot_read_virtual_origens_tables(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> None:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.fetch("select * from public.memberships")
    finally:
        await connection.close()


async def test_users_cannot_read_the_ledger(session: asyncpg.Connection) -> None:
    async with acting_as(session, None):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await session.fetch("select * from soc_migrations.applied")
