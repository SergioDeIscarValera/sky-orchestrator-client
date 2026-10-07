#!/usr/bin/env python3
"""Suggest and verify the next platform version (ADR-0003).

The version is a human decision, made once in the release branch name. This tool
makes the decision informed, then verifies it on the way to main, so a release
carrying a breaking change cannot be tagged as a patch.

Usage:
    next_version.py                           suggest the next version
    next_version.py --verify v0.2.0           check a chosen version
    next_version.py --branch release/v0.2.0   verify the version a branch declares
    next_version.py --current                 print the latest tag

Exit status: 0 when the answer is valid, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from enum import IntEnum

VERSION_PATTERN = re.compile(
    r"^v(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)$"
)
BRANCH_PATTERN = re.compile(r"^(?:release|hotfix|backmerge)/(?P<version>v\d+\.\d+\.\d+)$")
HEADER_PATTERN = re.compile(r"^(?P<type>[a-z]+)\((?P<scope>[a-z-]+)\)(?P<breaking>!)?: ")
MINOR_TYPES = frozenset({"feat"})


class Bump(IntEnum):
    PATCH = 0
    MINOR = 1
    MAJOR = 2


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, text: str) -> Version | None:
        match = VERSION_PATTERN.match(text.strip())
        if match is None:
            return None
        return cls(int(match["major"]), int(match["minor"]), int(match["patch"]))

    @classmethod
    def from_branch(cls, branch: str) -> Version | None:
        match = BRANCH_PATTERN.match(branch.strip())
        return None if match is None else cls.parse(match["version"])

    def bumped(self, bump: Bump) -> Version:
        effective = Bump(max(bump - 1, Bump.PATCH)) if self.major == 0 else bump
        if effective is Bump.MAJOR:
            return Version(self.major + 1, 0, 0)
        if effective is Bump.MINOR:
            return Version(self.major, self.minor + 1, 0)
        return Version(self.major, self.minor, self.patch + 1)

    def __str__(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}"


FIRST_RELEASE = Version(0, 1, 0)


def bump_for(subjects: list[str]) -> Bump:
    bump = Bump.PATCH
    for subject in subjects:
        match = HEADER_PATTERN.match(subject.strip())
        if match is None:
            continue
        if match["breaking"]:
            return Bump.MAJOR
        if match["type"] in MINOR_TYPES:
            bump = Bump.MINOR
    return bump


def suggest(current: Version | None, subjects: list[str]) -> Version:
    return FIRST_RELEASE if current is None else current.bumped(bump_for(subjects))


def problems_with(chosen: Version, current: Version | None, subjects: list[str]) -> list[str]:
    problems: list[str] = []
    if current is not None and chosen <= current:
        problems.append(f"{chosen} is not greater than the latest tag {current}")
    minimum = suggest(current, subjects)
    if chosen < minimum:
        problems.append(
            f"{chosen} is a smaller bump than the commits require: they contain a "
            f"{bump_for(subjects).name.lower()} change, so the minimum is {minimum}"
        )
    return problems


class Repository:
    def latest_tag(self) -> Version | None:
        versions = [
            version
            for line in self._git("tag", "--list", "v*").splitlines()
            if (version := Version.parse(line))
        ]
        return max(versions, default=None)

    def subjects_since(self, tag: Version | None) -> list[str]:
        revision_range = f"{tag}..HEAD" if tag else "HEAD"
        return [line for line in self._git("log", "--format=%s", revision_range).splitlines() if line]

    @staticmethod
    def _git(*arguments: str) -> str:
        try:
            return subprocess.run(
                ["git", *arguments], capture_output=True, text=True, check=True
            ).stdout.strip()
        except subprocess.CalledProcessError:
            return ""


def main(argv: list[str] | None = None, repository: Repository | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", metavar="VERSION", help="check a chosen version, e.g. v0.2.0")
    parser.add_argument("--branch", metavar="NAME", help="verify the version a branch declares")
    parser.add_argument("--current", action="store_true", help="print the latest tag")
    arguments = parser.parse_args(argv)
    repository = repository or Repository()

    current = repository.latest_tag()
    if arguments.current:
        print(current or "none")
        return 0

    subjects = repository.subjects_since(current)
    chosen_text = arguments.verify
    if arguments.branch:
        declared = Version.from_branch(arguments.branch)
        if declared is None:
            print(
                f"Branch '{arguments.branch}' does not declare a version. "
                "Expected release/vX.Y.Z or hotfix/vX.Y.Z.",
                file=sys.stderr,
            )
            return 1
        chosen_text = str(declared)

    if chosen_text is None:
        print(suggest(current, subjects))
        print(
            f"  from {current or 'no tags yet'}, {len(subjects)} commit(s), "
            f"{bump_for(subjects).name.lower()} change detected",
            file=sys.stderr,
        )
        return 0

    chosen = Version.parse(chosen_text)
    if chosen is None:
        print(f"'{chosen_text}' is not a version of the form vX.Y.Z", file=sys.stderr)
        return 1
    problems = problems_with(chosen, current, subjects)
    if problems:
        print(f"{chosen} rejected:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(chosen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
