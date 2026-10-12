#!/usr/bin/env python3
"""Verify that every relative link in the repository's Markdown resolves.

External links are not checked: a network call cannot be a gate test.

Usage:
    check_links.py [root]

Exit status: 0 when every relative link resolves, 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

LINK_PATTERN = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`\n]*`")
EXTERNAL_SCHEMES = ("http://", "https://", "mailto:", "tel:", "ftp://")
SKIPPED_DIRECTORIES = frozenset(
    {".git", "node_modules", ".venv", "venv", "build", "dist", ".pnpm-store", ".pytest_cache"}
)
#: Another repository's files, kept byte for byte: their links point into that one.
VENDORED = ("contracts", "sky-orchestrator")


@dataclass(frozen=True)
class BrokenLink:
    source: Path
    target: str


def markdown_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*.md")):
        parts = path.relative_to(root).parts
        vendored = parts[: len(VENDORED)] == VENDORED and len(parts) > len(VENDORED) + 1
        if not SKIPPED_DIRECTORIES.intersection(parts) and not vendored:
            yield path


def link_targets(text: str) -> list[str]:
    prose = INLINE_CODE.sub("", FENCED_CODE.sub("", text))
    return LINK_PATTERN.findall(prose)


def is_local(target: str) -> bool:
    return not target.startswith(EXTERNAL_SCHEMES) and not target.startswith("#")


def resolves(source: Path, target: str) -> bool:
    path = target.split("#", 1)[0]
    return not path or (source.parent / path).exists()


def broken_links(root: Path) -> list[BrokenLink]:
    return [
        BrokenLink(source, target)
        for source in markdown_files(root)
        for target in link_targets(source.read_text(encoding="utf-8"))
        if is_local(target) and not resolves(source, target)
    ]


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    root = Path(arguments[0]).resolve() if arguments else Path.cwd()

    broken = broken_links(root)
    if broken:
        print(f"{len(broken)} broken relative link(s):\n", file=sys.stderr)
        for link in broken:
            print(f"  {link.source.relative_to(root)} -> {link.target}", file=sys.stderr)
        return 1

    print(f"All relative links resolve across {sum(1 for _ in markdown_files(root))} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
