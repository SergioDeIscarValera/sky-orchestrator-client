"""Apply SOC's migrations to schema soc in Virtual Origen's database (FR-DEP-02).

The connection string comes from an environment variable, never from an argument.
The service roles' passwords come from SOC_DB_PASSWORD_SOC_CLOUD and
SOC_DB_PASSWORD_SOC_OPERATIONS and are stored as SCRAM verifiers only.

Usage:
    soc-migrate                     apply what is pending, then set the role passwords
    soc-migrate --dry-run           show what is applied and what is pending
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg

from soc_migrate.migrations import Migration, MigrationError, discover
from soc_migrate.plan import Plan
from soc_migrate.roles import RolePassword, role_passwords
from soc_migrate.runner import Runner


async def migrate(
    dsn: str, available: list[Migration], passwords: list[RolePassword], *, dry_run: bool
) -> Plan:
    connection = await asyncpg.connect(dsn)
    try:
        return await Runner(connection).run(available, passwords, dry_run=dry_run)
    finally:
        await connection.close()


def report(result: Plan, passwords: list[RolePassword], *, dry_run: bool) -> None:
    for record in result.applied:
        print(f"applied     {record.version:04d}-{record.name}")
    for migration in result.pending:
        print(f"{'pending ' if dry_run else 'applying'}    {migration.label}")
    if not result.pending:
        print("nothing to apply")
    for password in passwords:
        print(f"password    {password.role}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("database/migrations"))
    parser.add_argument("--dsn-variable", default="SOC_MIGRATE_DSN")
    parser.add_argument("--dry-run", action="store_true")
    arguments = parser.parse_args(argv)

    dsn = os.environ.get(arguments.dsn_variable, "")
    if not dsn:
        print(f"{arguments.dsn_variable} is not set", file=sys.stderr)
        return 2

    try:
        available = discover(arguments.directory)
        passwords = [] if arguments.dry_run else role_passwords(os.environ)
        result = asyncio.run(migrate(dsn, available, passwords, dry_run=arguments.dry_run))
    except (MigrationError, asyncpg.PostgresError, OSError) as error:
        print(f"soc-migrate: {error}", file=sys.stderr)
        return 1

    report(result, passwords, dry_run=arguments.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
