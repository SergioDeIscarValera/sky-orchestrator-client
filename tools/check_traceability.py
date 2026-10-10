#!/usr/bin/env python3
"""Hold the traceability matrix equal to the requirement documents.

Every FR and NFR heading has exactly one row in docs/requirements/traceability.md,
and every row names a requirement that exists, with the same priority.

Usage:
    check_traceability.py [root]
    check_traceability.py [root] --skeleton    print a row for each requirement without one

Exit status: 0 when the matrix and the requirements agree, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

REQUIREMENT_DOCUMENTS = (
    Path("docs/requirements/functional-requirements.md"),
    Path("docs/requirements/non-functional-requirements.md"),
)
MATRIX = Path("docs/requirements/traceability.md")

HEADING_PATTERN = re.compile(
    r"^### (?P<id>N?FR-[A-Z]+-\d{2}) — (?P<title>.+?) · (?P<priority>MUST|SHOULD|COULD|WONT)$",
    re.MULTILINE,
)
ROW_PATTERN = re.compile(
    r"^\| (?P<id>N?FR-[A-Z]+-\d{2}) \| (?P<priority>MUST|SHOULD|COULD|WONT) \|", re.MULTILINE
)


@dataclass(frozen=True)
class Requirement:
    id: str
    title: str
    priority: str


def requirements_in(root: Path) -> list[Requirement]:
    found: list[Requirement] = []
    for document in REQUIREMENT_DOCUMENTS:
        text = (root / document).read_text(encoding="utf-8")
        found.extend(
            Requirement(match["id"], match["title"], match["priority"])
            for match in HEADING_PATTERN.finditer(text)
        )
    return found


def rows_in(root: Path) -> list[tuple[str, str]]:
    text = (root / MATRIX).read_text(encoding="utf-8")
    return [(match["id"], match["priority"]) for match in ROW_PATTERN.finditer(text)]


def disagreements(requirements: list[Requirement], rows: list[tuple[str, str]]) -> list[str]:
    problems: list[str] = []
    for identifier, count in Counter(r.id for r in requirements).items():
        if count > 1:
            problems.append(f"{identifier} is defined {count} times")
    for identifier, count in Counter(identifier for identifier, _ in rows).items():
        if count > 1:
            problems.append(f"{identifier} has {count} rows in the matrix")

    defined = {requirement.id: requirement.priority for requirement in requirements}
    traced = dict(rows)
    problems.extend(
        f"{identifier} has no row in the matrix" for identifier in defined.keys() - traced.keys()
    )
    problems.extend(
        f"{identifier} in the matrix is not a requirement"
        for identifier in traced.keys() - defined.keys()
    )
    problems.extend(
        f"{identifier} is {defined[identifier]} but its row says {traced[identifier]}"
        for identifier in defined.keys() & traced.keys()
        if defined[identifier] != traced[identifier]
    )
    return sorted(problems)


def skeleton(requirements: list[Requirement], rows: list[tuple[str, str]]) -> list[str]:
    traced = {identifier for identifier, _ in rows}
    return [
        f"| {requirement.id} | {requirement.priority} | — | — | — | Planned |"
        for requirement in requirements
        if requirement.id not in traced
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", help="the repository root")
    parser.add_argument(
        "--skeleton", action="store_true", help="print rows for untraced requirements"
    )
    arguments = parser.parse_args(argv)
    root = Path(arguments.root).resolve()

    requirements = requirements_in(root)
    rows = rows_in(root)
    if arguments.skeleton:
        print("\n".join(skeleton(requirements, rows)))
        return 0

    problems = disagreements(requirements, rows)
    if problems:
        print(
            f"The traceability matrix disagrees with the requirements ({len(problems)}):",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(f"{len(requirements)} requirements, each traced once.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
