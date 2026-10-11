#!/usr/bin/env python3
"""Validate commit messages against the convention in CONTRIBUTING.md (ADR-0003).

Usage:
    lint_commits.py --file .git/COMMIT_EDITMSG
    lint_commits.py --message "feat(cloud): answer the dock's resource request"
    lint_commits.py --range origin/develop..HEAD

Exit status: 0 when every message is valid, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

TYPES = ("feat", "fix", "docs", "test", "refactor", "perf", "build", "ci", "chore", "revert")
SCOPES = ("web", "cloud", "operations", "libs", "database", "contracts", "infra", "tools", "repo")

MAX_HEADER = 100
MIN_SUBJECT = 10
MAX_SUBJECT = 72

HEADER_PATTERN = re.compile(
    r"^(?P<type>[a-z]+)\((?P<scope>[a-z-]+)\)(?P<breaking>!)?: (?P<subject>.+)$"
)
CO_AUTHOR_PATTERN = re.compile(r"^\s*co-authored-by\s*:", re.IGNORECASE | re.MULTILINE)
SCISSORS = "# ------------------------ >8 ------------------------"
GIT_GENERATED_PREFIXES = (
    "Merge branch",
    "Merge remote-tracking branch",
    "Merge pull request",
    "Merge tag",
    'Revert "',
    "fixup!",
    "squash!",
    "amend!",
)
DEPENDABOT_AUTHOR = "49699333+dependabot[bot]@users.noreply.github.com"
WAIVED_FOR_DEPENDABOT = frozenset({"single-line"})


@dataclass(frozen=True)
class Problem:
    rule: str
    detail: str

    def __str__(self) -> str:
        return f"  [{self.rule}] {self.detail}"


@dataclass(frozen=True)
class Message:
    header: str
    extra_lines: tuple[str, ...]
    raw: str

    @classmethod
    def parse(cls, text: str) -> Message:
        lines = without_git_comments(text).split("\n")
        return cls(
            header=lines[0],
            extra_lines=tuple(line for line in lines[1:] if line.strip()),
            raw=text,
        )

    @property
    def is_empty(self) -> bool:
        return not self.header.strip() and not self.extra_lines

    @property
    def is_git_generated(self) -> bool:
        return self.header.startswith(GIT_GENERATED_PREFIXES)


@dataclass(frozen=True)
class Header:
    type: str
    scope: str
    subject: str
    breaking: bool


@dataclass(frozen=True)
class Commit:
    sha: str
    author: str
    message: str


def without_git_comments(text: str) -> str:
    kept: list[str] = []
    for line in text.splitlines():
        if line.startswith(SCISSORS):
            break
        if not line.startswith("#"):
            kept.append(line)
    return "\n".join(kept).strip("\n")


def parse_header(header: str) -> Header | None:
    match = HEADER_PATTERN.match(header)
    if match is None:
        return None
    return Header(
        type=match["type"],
        scope=match["scope"],
        subject=match["subject"],
        breaking=match["breaking"] is not None,
    )


HeaderRule = Callable[[Header], Problem | None]
MessageRule = Callable[[Message], Problem | None]


def known_type(header: Header) -> Problem | None:
    if header.type in TYPES:
        return None
    return Problem("type", f"'{header.type}' is not an allowed type. Allowed: {', '.join(TYPES)}")


def known_scope(header: Header) -> Problem | None:
    if header.scope in SCOPES:
        return None
    return Problem(
        "scope", f"'{header.scope}' is not an allowed scope. Allowed: {', '.join(SCOPES)}"
    )


def trimmed_subject(header: Header) -> Problem | None:
    if header.subject == header.subject.strip():
        return None
    return Problem("subject-whitespace", "subject has leading or trailing whitespace")


def no_trailing_period(header: Header) -> Problem | None:
    if not header.subject.endswith("."):
        return None
    return Problem("subject-period", "subject must not end with a full stop")


def lower_case_start(header: Header) -> Problem | None:
    if not header.subject[:1].isupper():
        return None
    return Problem("subject-case", "subject must start in lower case")


def subject_length(header: Header) -> Problem | None:
    length = len(header.subject)
    if MIN_SUBJECT <= length <= MAX_SUBJECT:
        return None
    return Problem(
        "subject-length",
        f"subject is {length} characters, allowed is {MIN_SUBJECT} to {MAX_SUBJECT}",
    )


def header_length(message: Message) -> Problem | None:
    if len(message.header) <= MAX_HEADER:
        return None
    return Problem(
        "header-length", f"header is {len(message.header)} characters, maximum is {MAX_HEADER}"
    )


def single_line(message: Message) -> Problem | None:
    if not message.extra_lines:
        return None
    return Problem(
        "single-line",
        f"a commit message is one line; found {len(message.extra_lines)} more. "
        "The detail belongs in the pull request description.",
    )


def no_co_author(message: Message) -> Problem | None:
    if CO_AUTHOR_PATTERN.search(message.raw) is None:
        return None
    return Problem("co-author", "'Co-authored-by' trailers are not accepted in this repository")


HEADER_RULES: tuple[HeaderRule, ...] = (
    known_type,
    known_scope,
    trimmed_subject,
    no_trailing_period,
    lower_case_start,
    subject_length,
)
MESSAGE_RULES: tuple[MessageRule, ...] = (header_length, single_line, no_co_author)


def lint(text: str) -> list[Problem]:
    message = Message.parse(text)
    if message.is_empty:
        return [Problem("empty", "commit message is empty")]
    if message.is_git_generated:
        return []

    problems = [problem for rule in MESSAGE_RULES if (problem := rule(message))]
    header = parse_header(message.header)
    if header is None:
        problems.append(
            Problem(
                "header-format",
                "header must be 'type(scope): subject', for example "
                "'feat(cloud): answer the dock's resource request'",
            )
        )
        return problems
    problems.extend(problem for rule in HEADER_RULES if (problem := rule(header)))
    return problems


def lint_commit(commit: Commit) -> list[Problem]:
    problems = lint(commit.message)
    if commit.author != DEPENDABOT_AUTHOR:
        return problems
    return [problem for problem in problems if problem.rule not in WAIVED_FOR_DEPENDABOT]


def commits_in_range(revision_range: str) -> list[Commit]:
    separator = "\x1e"
    output = subprocess.run(
        ["git", "log", f"--format=%H%n%ae%n%B{separator}", revision_range],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    commits: list[Commit] = []
    for chunk in output.split(separator):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        sha, _, rest = chunk.partition("\n")
        author, _, message = rest.partition("\n")
        commits.append(Commit(sha.strip(), author.strip(), message))
    return commits


def report(label: str, problems: Iterable[Problem], text: str) -> None:
    header = text.strip().splitlines()[0] if text.strip() else "(empty)"
    print(f"\n{label}: {header}", file=sys.stderr)
    for problem in problems:
        print(problem, file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="a file holding one commit message")
    source.add_argument("--message", help="one commit message")
    source.add_argument("--range", dest="revision_range", help="a git revision range")
    arguments = parser.parse_args(argv)

    if arguments.revision_range:
        commits = commits_in_range(arguments.revision_range)
    else:
        text = (
            Path(arguments.file).read_text(encoding="utf-8")
            if arguments.file
            else arguments.message
        )
        commits = [Commit("", "", text)]

    rejected = 0
    for commit in commits:
        problems = lint_commit(commit) if commit.sha else lint(commit.message)
        if problems:
            rejected += 1
            report(commit.sha[:12] or "commit message", problems, commit.message)

    if rejected:
        print(
            f"\n{rejected} commit message(s) rejected. Convention: CONTRIBUTING.md, ADR-0003.\n"
            "Do not bypass with --no-verify.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
