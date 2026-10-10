from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

FILE_PATTERN = re.compile(r"^(?P<version>\d{4})-(?P<name>[a-z0-9]+(?:-[a-z0-9]+)*)\.sql$")


class MigrationError(Exception):
    pass


@dataclass(frozen=True, order=True)
class Migration:
    version: int
    name: str
    sql: str = field(compare=False, repr=False)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.sql.encode("utf-8")).hexdigest()

    @property
    def label(self) -> str:
        return f"{self.version:04d}-{self.name}"


def discover(directory: Path) -> list[Migration]:
    migrations: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        match = FILE_PATTERN.match(path.name)
        if match is None:
            raise MigrationError(f"{path.name} is not named NNNN-kebab-name.sql")
        migrations.append(
            Migration(int(match["version"]), match["name"], path.read_text(encoding="utf-8"))
        )

    expected = list(range(1, len(migrations) + 1))
    found = [migration.version for migration in migrations]
    if found != expected:
        raise MigrationError(f"versions must run 1..n without gaps or repeats, found {found}")
    return migrations
