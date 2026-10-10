#!/usr/bin/env python3
"""Validate a branch name and the Git Flow direction of a pull request (ADR-0003).

GitHub rulesets constrain which branch a pull request targets, never which branch
it comes from, so the direction rule lives here and runs in the pull request policy.

Usage:
    check_branch.py --branch feature/web/fleet-panel
    check_branch.py --branch release/v0.2.0 --base main

Exit status: 0 when the name and the direction are valid, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lint_commits import SCOPES
from next_version import Version

PROTECTED = ("main", "develop")
WORK_BRANCH_PATTERN = re.compile(
    r"^(?P<kind>feature|bugfix)/(?P<scope>[a-z0-9-]+)/(?P<slug>[a-z0-9][a-z0-9.-]*)$"
)
VERSIONED_KINDS = ("release/", "hotfix/", "backmerge/")
DEPENDABOT_PATTERN = re.compile(r"^dependabot/[a-z0-9_-]+/[A-Za-z0-9_./@+-]+$")
NEVER_A_HEAD = ("main",)
ALLOWED_SOURCES = {
    "main": ("develop", "release/*", "hotfix/*"),
    "develop": ("feature/*", "bugfix/*", "release/*", "hotfix/*", "backmerge/*", "dependabot/*"),
}


def matches(branch: str, pattern: str) -> bool:
    return branch.startswith(pattern[:-1]) if pattern.endswith("/*") else branch == pattern


def check_name(branch: str) -> list[str]:
    if branch in PROTECTED:
        return []
    if branch.startswith(VERSIONED_KINDS):
        if Version.from_branch(branch) is None:
            return [f"'{branch}' does not declare a version. Expected <kind>/vX.Y.Z."]
        return []
    if branch.startswith("dependabot/"):
        if DEPENDABOT_PATTERN.match(branch) and ".." not in branch:
            return []
        return [f"'{branch}' is not a branch Dependabot writes: dependabot/<ecosystem>/<name>"]

    match = WORK_BRANCH_PATTERN.match(branch)
    if match is None:
        return [
            f"'{branch}' is not a valid branch name. Expected feature/<scope>/<slug> or "
            "bugfix/<scope>/<slug>, lower case, words separated by hyphens."
        ]
    if match["scope"] not in SCOPES:
        return [f"'{match['scope']}' is not an allowed scope. Allowed: {', '.join(SCOPES)}"]
    return []


def check_direction(head: str, base: str) -> list[str]:
    if head in NEVER_A_HEAD:
        return [
            f"'{head}' may not be the head of a pull request: automatic head-branch deletion "
            "would delete it on merge. Cut a backmerge/vX.Y.Z branch from it instead."
        ]
    allowed = ALLOWED_SOURCES.get(base)
    if allowed is None or any(matches(head, pattern) for pattern in allowed):
        return []
    return [f"'{head}' may not target '{base}'. {base} accepts only: {', '.join(allowed)}."]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True, help="the head branch")
    parser.add_argument("--base", help="the branch the pull request targets")
    arguments = parser.parse_args(argv)

    problems = check_name(arguments.branch)
    if arguments.base:
        problems += check_direction(arguments.branch, arguments.base)

    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        print("\nBranching rules: CONTRIBUTING.md, ADR-0003.", file=sys.stderr)
        return 1

    target = f" -> {arguments.base}" if arguments.base else ""
    print(f"{arguments.branch}{target} is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
