#!/usr/bin/env python3
"""Merge a pull request only once every check on it has passed (ADR-0003).

The free private plan does not enforce the rulesets in .github/rulesets, so this
is where "merge only when green" holds: it waits while any check is pending, then
merges with a merge commit only if every check passed and every check the
rulesets require is among them. Anything else is refused, naming each check.

Usage:
    merge_when_green.py 31
    merge_when_green.py 31 --repo owner/name --timeout-s 1800

Exit status: 0 when GitHub reports the pull request merged, 1 when refused,
still pending at the timeout, or not merged after every attempt. A merge is
believed only from the pull request's state: right after its checks GitHub may
still be computing whether it can merge, and with branches deleted on merge
`gh pr merge --delete-branch` fails after a merge that worked.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

RULESETS = Path(__file__).resolve().parents[1] / ".github" / "rulesets"
REPOSITORY = "SergioDeIscarValera/sky-orchestrator-client"
FINISHED_WELL = frozenset({"pass", "skipping"})
PENDING = "pending"
MERGED = "MERGED"
MERGE_ATTEMPTS = 4
MERGE_RETRY_S = 10.0

Runner = Callable[[Sequence[str]], str]


@dataclass(frozen=True)
class Check:
    name: str
    state: str


@dataclass(frozen=True)
class Verdict:
    waiting: bool
    problems: tuple[str, ...]

    @property
    def green(self) -> bool:
        return not self.waiting and not self.problems


def required_checks(rulesets: Path = RULESETS) -> frozenset[str]:
    required: set[str] = set()
    for path in sorted(rulesets.glob("*.json")):
        for rule in json.loads(path.read_text(encoding="utf-8")).get("rules", []):
            if rule["type"] == "required_status_checks":
                parameters = rule["parameters"]["required_status_checks"]
                required.update(check["context"] for check in parameters)
    return frozenset(required)


def parse(text: str) -> list[Check]:
    checks = []
    for line in text.splitlines():
        fields = line.split("\t")
        if len(fields) >= 2 and fields[0].strip():
            checks.append(Check(fields[0].strip(), fields[1].strip()))
    return checks


def verdict(checks: Sequence[Check], required: frozenset[str]) -> Verdict:
    unreported = sorted(required - {check.name for check in checks})
    pending = [check.name for check in checks if check.state == PENDING]
    if pending or unreported:
        return Verdict(
            waiting=True,
            problems=(
                *(f"{name} is pending" for name in pending),
                *(f"{name} has not reported" for name in unreported),
            ),
        )
    problems = [
        f"{check.name} is {check.state}" for check in checks if check.state not in FINISHED_WELL
    ]
    return Verdict(waiting=False, problems=tuple(problems))


def gh(arguments: Sequence[str]) -> str:
    return subprocess.run(["gh", *arguments], capture_output=True, text=True, check=False).stdout


def main(
    argv: list[str] | None = None,
    runner: Runner = gh,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("number", type=int, help="the pull request")
    parser.add_argument("--repo", default=REPOSITORY)
    parser.add_argument("--timeout-s", type=float, default=1800.0)
    parser.add_argument("--interval-s", type=float, default=15.0)
    arguments = parser.parse_args(argv)

    number = str(arguments.number)
    required = required_checks()
    deadline = clock() + arguments.timeout_s
    while True:
        checks = parse(runner(["pr", "checks", number, "--repo", arguments.repo]))
        current = verdict(checks, required)
        if not current.waiting or clock() >= deadline:
            break
        sleep(arguments.interval_s)

    if current.waiting:
        print(f"#{number}: still waiting after {arguments.timeout_s:.0f} s:", file=sys.stderr)
        for problem in current.problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    if current.problems:
        print(f"#{number} is not green, not merging:", file=sys.stderr)
        for problem in current.problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    state = ""
    for attempt in range(MERGE_ATTEMPTS):
        if attempt > 0:
            sleep(MERGE_RETRY_S)
        runner(["pr", "merge", number, "--repo", arguments.repo, "--merge", "--delete-branch"])
        state = runner(
            ["pr", "view", number, "--repo", arguments.repo, "--json", "state", "--jq", ".state"]
        ).strip()
        if state == MERGED:
            print(f"#{number} merged: {', '.join(sorted(check.name for check in checks))} passed")
            return 0
    print(
        f"#{number} is green but was not merged: GitHub reports it {state or 'unknown'} "
        f"after {MERGE_ATTEMPTS} attempts",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
