from __future__ import annotations

from pathlib import Path

import pytest

from soc_migrate.migrations import Migration, MigrationError, discover


def write(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_text(f"-- {name}\nselect 1;\n", encoding="utf-8")


def test_migrations_are_found_in_version_order(tmp_path: Path) -> None:
    write(tmp_path, "0002-service-roles.sql", "0001-soc-schema.sql")
    found = discover(tmp_path)
    assert [(migration.version, migration.name) for migration in found] == [
        (1, "soc-schema"),
        (2, "service-roles"),
    ]


def test_an_empty_directory_has_no_migrations(tmp_path: Path) -> None:
    assert discover(tmp_path) == []


@pytest.mark.parametrize(
    "name",
    [
        "1-soc-schema.sql",
        "0001_soc_schema.sql",
        "0001-Soc-Schema.sql",
        "0001-.sql",
        "0001-soc--schema.sql",
    ],
)
def test_a_badly_named_file_is_refused(tmp_path: Path, name: str) -> None:
    write(tmp_path, name)
    with pytest.raises(MigrationError, match="NNNN-kebab-name"):
        discover(tmp_path)


@pytest.mark.parametrize(
    "names",
    [
        ("0002-second.sql",),
        ("0001-first.sql", "0003-third.sql"),
        ("0001-first.sql", "0001-again.sql"),
    ],
)
def test_versions_run_from_one_without_gaps_or_repeats(
    tmp_path: Path, names: tuple[str, ...]
) -> None:
    write(tmp_path, *names)
    with pytest.raises(MigrationError, match="without gaps or repeats"):
        discover(tmp_path)


def test_the_checksum_is_of_the_exact_text() -> None:
    first = Migration(1, "x", "select 1;\n")
    assert first.sha256 == Migration(1, "x", "select 1;\n").sha256
    assert first.sha256 != Migration(1, "x", "select 1; \n").sha256
    assert first.label == "0001-x"
