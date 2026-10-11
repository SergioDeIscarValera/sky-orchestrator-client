#!/usr/bin/env python3
"""Delete local branches whose remote branch was deleted after its merge.

GitHub deletes a merged pull request's branch (tools/setup_github.sh); this does
the same on a clone. It fetches with pruning, then deletes each local branch whose
upstream is gone, with `git branch -d`, which refuses a branch that is not merged.
`main`, `develop` and the current branch are never touched.

Usage:
    prune_branches.py              delete
    prune_branches.py --dry-run    list what would be deleted

Exit status: 0 when every candidate was deleted or listed, 1 otherwise.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass

PROTECTED = frozenset({"main", "develop"})
GONE = "[gone]"

Git = Callable[..., str]


def run_git(*arguments: str) -> str:
    return subprocess.run(["git", *arguments], capture_output=True, text=True, check=True).stdout


@dataclass(frozen=True)
class LocalBranch:
    name: str
    upstream_gone: bool
    current: bool


def local_branches(git: Git) -> list[LocalBranch]:
    output = git(
        "for-each-ref", "--format=%(HEAD)|%(refname:short)|%(upstream:track)", "refs/heads"
    )
    branches: list[LocalBranch] = []
    for line in output.splitlines():
        head, name, track = line.split("|", 2)
        branches.append(LocalBranch(name=name, upstream_gone=track == GONE, current=head == "*"))
    return branches


def candidates(branches: list[LocalBranch]) -> list[str]:
    return [
        branch.name
        for branch in branches
        if branch.upstream_gone and not branch.current and branch.name not in PROTECTED
    ]


def main(argv: list[str] | None = None, git: Git = run_git) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="list without deleting")
    arguments = parser.parse_args(argv)

    git("fetch", "--prune", "--quiet")
    names = candidates(local_branches(git))
    if not names:
        print("Nothing to prune.")
        return 0

    failures = 0
    for name in names:
        if arguments.dry_run:
            print(f"would delete {name}")
            continue
        try:
            git("branch", "-d", name)
            print(f"deleted {name}")
        except subprocess.CalledProcessError as error:
            failures += 1
            print(f"kept {name}: {error.stderr.strip() or 'not fully merged'}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
