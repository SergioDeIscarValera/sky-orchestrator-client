from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from soc_migrate.migrations import Migration, MigrationError


@dataclass(frozen=True)
class AppliedMigration:
    version: int
    name: str
    sha256: str


@dataclass(frozen=True)
class Plan:
    applied: tuple[AppliedMigration, ...]
    pending: tuple[Migration, ...]


def plan(available: Sequence[Migration], applied: Sequence[AppliedMigration]) -> Plan:
    by_version = {migration.version: migration for migration in available}
    for record in applied:
        migration = by_version.get(record.version)
        if migration is None:
            raise MigrationError(
                f"migration {record.version:04d}-{record.name} was applied "
                "but is not in the repository"
            )
        if migration.name != record.name:
            raise MigrationError(
                f"migration {record.version:04d} was applied as '{record.name}' "
                f"and is now named '{migration.name}'"
            )
        if migration.sha256 != record.sha256:
            raise MigrationError(
                f"migration {migration.label} was edited after it was applied: "
                "add a new migration instead"
            )

    applied_versions = sorted(record.version for record in applied)
    if applied_versions != list(range(1, len(applied_versions) + 1)):
        raise MigrationError(f"the ledger has gaps: {applied_versions}")

    done = len(applied_versions)
    return Plan(
        applied=tuple(sorted(applied, key=lambda record: record.version)),
        pending=tuple(migration for migration in available if migration.version > done),
    )
