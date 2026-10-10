from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

import asyncpg

from soc_migrate.migrations import Migration
from soc_migrate.plan import AppliedMigration, Plan, plan
from soc_migrate.roles import RolePassword

LOCK_KEY = "soc-migrations"
LEDGER_DDL = """
create schema if not exists soc_migrations;
revoke all on schema soc_migrations from public;
create table if not exists soc_migrations.applied (
  version    integer primary key,
  name       text not null,
  sha256     text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user
);
"""


class Runner:
    def __init__(self, connection: asyncpg.Connection) -> None:
        self._connection = connection

    async def run(
        self,
        available: Sequence[Migration],
        passwords: Sequence[RolePassword],
        *,
        dry_run: bool = False,
    ) -> Plan:
        async with self._exclusive():
            await self._connection.execute(LEDGER_DDL)
            current = plan(available, await self._applied())
            if dry_run:
                return current
            for migration in current.pending:
                await self._apply(migration)
            for password in passwords:
                await self._set_password(password)
            return current

    @asynccontextmanager
    async def _exclusive(self) -> AsyncIterator[None]:
        await self._connection.execute("select pg_advisory_lock(hashtext($1))", LOCK_KEY)
        try:
            yield
        finally:
            await self._connection.execute("select pg_advisory_unlock(hashtext($1))", LOCK_KEY)

    async def _applied(self) -> list[AppliedMigration]:
        rows = await self._connection.fetch(
            "select version, name, sha256 from soc_migrations.applied order by version"
        )
        return [AppliedMigration(row["version"], row["name"], row["sha256"]) for row in rows]

    async def _apply(self, migration: Migration) -> None:
        async with self._connection.transaction():
            await self._connection.execute(migration.sql)
            await self._connection.execute(
                "insert into soc_migrations.applied (version, name, sha256) values ($1, $2, $3)",
                migration.version,
                migration.name,
                migration.sha256,
            )

    async def _set_password(self, password: RolePassword) -> None:
        statement = await self._connection.fetchval(
            "select format('alter role %I with password %L', $1::text, $2::text)",
            password.role,
            password.verifier(os.urandom(16)),
        )
        await self._connection.execute(statement)
