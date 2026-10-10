from __future__ import annotations

import pytest

from soc_migrate.migrations import Migration, MigrationError
from soc_migrate.plan import AppliedMigration, plan

AVAILABLE = [
    Migration(1, "soc-schema", "create schema soc;"),
    Migration(2, "service-roles", "create role soc_cloud;"),
    Migration(3, "realtime-authorization", "create policy p on t;"),
]


def recorded(*migrations: Migration) -> list[AppliedMigration]:
    return [AppliedMigration(m.version, m.name, m.sha256) for m in migrations]


def test_a_fresh_database_gets_every_migration() -> None:
    assert plan(AVAILABLE, []).pending == tuple(AVAILABLE)


def test_only_what_is_newer_than_the_ledger_is_pending() -> None:
    result = plan(AVAILABLE, recorded(*AVAILABLE[:2]))
    assert result.pending == (AVAILABLE[2],)
    assert [record.version for record in result.applied] == [1, 2]


def test_an_up_to_date_database_has_nothing_pending() -> None:
    assert plan(AVAILABLE, recorded(*AVAILABLE)).pending == ()


def test_an_edited_migration_is_refused() -> None:
    edited = [
        AVAILABLE[0],
        Migration(2, "service-roles", "create role soc_cloud login;"),
        AVAILABLE[2],
    ]
    with pytest.raises(MigrationError, match="0002-service-roles was edited"):
        plan(edited, recorded(*AVAILABLE[:2]))


def test_a_renamed_migration_is_refused() -> None:
    renamed = [Migration(1, "schema", AVAILABLE[0].sql), *AVAILABLE[1:]]
    with pytest.raises(MigrationError, match="applied as 'soc-schema'"):
        plan(renamed, recorded(AVAILABLE[0]))


def test_a_migration_missing_from_the_repository_is_refused() -> None:
    with pytest.raises(MigrationError, match="not in the repository"):
        plan(AVAILABLE[:1], recorded(*AVAILABLE[:2]))


def test_a_ledger_with_gaps_is_refused() -> None:
    with pytest.raises(MigrationError, match="gaps"):
        plan(AVAILABLE, recorded(AVAILABLE[0], AVAILABLE[2]))
