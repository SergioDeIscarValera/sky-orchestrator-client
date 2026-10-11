#!/usr/bin/env python3
"""Hold the aircraft catalogue to its schema, and the database to the catalogue.

`contracts/catalogue/aircraft-models.json` is the source (FR-FLE-01). A
migration loads it with `select soc.load_aircraft_models($catalogue$...$catalogue$)`,
the catalogue embedded byte for byte, because a migration is immutable once
applied: a changed catalogue is a new migration, and `--check` fails until the
newest one that loads the catalogue embeds the file as it is.

Usage:
    catalogue_migration.py --render        # the load statement for a new migration
    catalogue_migration.py --check         # schema, sources, and the newest migration

Exit status: 0 when the catalogue is valid and loaded as it is, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / "contracts" / "catalogue" / "aircraft-models.json"
SCHEMA = ROOT / "contracts" / "catalogue" / "aircraft-models.schema.json"
MIGRATIONS = ROOT / "database" / "migrations"
QUOTE = "$catalogue$"
EMBEDDED = re.compile(re.escape(QUOTE) + r"\n(.*?)\n" + re.escape(QUOTE), re.DOTALL)
SOURCE = re.compile(r"^https://\S+$")


def render(catalogue: str) -> str:
    return (
        "-- Loaded from contracts/catalogue/aircraft-models.json by\n"
        "-- tools/catalogue_migration.py; a changed catalogue is a new migration.\n"
        f"select soc.load_aircraft_models({QUOTE}\n{catalogue.rstrip()}\n{QUOTE}::jsonb);\n"
    )


def embedded(sql: str) -> str | None:
    found = EMBEDDED.search(sql)
    return found[1] if found else None


def newest_load(migrations: Path) -> tuple[Path, str] | None:
    loads = [
        (path, text)
        for path in sorted(migrations.glob("*.sql"))
        if (text := embedded(path.read_text(encoding="utf-8"))) is not None
    ]
    return loads[-1] if loads else None


def values(node: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """Every published value in the catalogue, with where it sits."""
    if isinstance(node, dict):
        if "value" in node:
            yield path, node
            return
        for key, child in node.items():
            yield from values(child, f"{path}/{key}")
    elif isinstance(node, list):
        for index, child in enumerate(node):
            yield from values(child, f"{path}/{index}")


def unsourced(catalogue: Any) -> list[str]:
    return [
        path
        for path, published in values(catalogue)
        if not isinstance(published.get("source"), str) or not SOURCE.match(published["source"])
    ]


def schema_problems(catalogue: Any) -> list[str]:
    import jsonschema_rs  # the check runs under uv; the unit tests run without it

    validator = jsonschema_rs.validator_for(json.loads(SCHEMA.read_text(encoding="utf-8")))
    return [
        f"{'/'.join(str(part) for part in error.instance_path)}: {error.message}"
        for error in validator.iter_errors(catalogue)
    ]


def check(catalogue_text: str, migrations: Path) -> list[str]:
    catalogue = json.loads(catalogue_text)
    problems = [*schema_problems(catalogue)]
    problems += [f"{path}: a published value without its source" for path in unsourced(catalogue)]
    keys = [model["model"] for model in catalogue.get("models", [])]
    if keys != sorted(set(keys)):
        problems.append("models must be unique and sorted by model")
    loaded = newest_load(migrations)
    if loaded is None:
        problems.append("no migration loads the catalogue")
    elif json.loads(loaded[1]) != catalogue:
        problems.append(f"{loaded[0].name} loads another catalogue: add a migration (--render)")
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--render", action="store_true")
    action.add_argument("--check", action="store_true")
    arguments = parser.parse_args(argv)

    catalogue_text = CATALOGUE.read_text(encoding="utf-8")
    if arguments.render:
        print(render(catalogue_text), end="")
        return 0
    problems = check(catalogue_text, MIGRATIONS)
    for problem in problems:
        print(problem, file=sys.stderr)
    if not problems:
        models = len(json.loads(catalogue_text)["models"])
        print(f"The catalogue's {models} models are valid, sourced and loaded as they are.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
