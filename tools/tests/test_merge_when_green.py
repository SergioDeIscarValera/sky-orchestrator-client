from __future__ import annotations

import io
import sys
import unittest
from collections.abc import Sequence
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import merge_when_green as mwg

URL = "https://github.com/owner/repo/actions/runs/1/job/2"


def checks(*states: tuple[str, str]) -> str:
    return "".join(f"{name}\t{state}\t1m2s\t{URL}\t\n" for name, state in states)


GREEN = checks(
    ("Gate", "pass"), ("GitGuardian Security Checks", "pass"), ("Pull request policy", "pass")
)
PENDING = checks(("Gate", "pending"), ("Pull request policy", "pass"))
RED = checks(
    ("Gate", "fail"), ("GitGuardian Security Checks", "pass"), ("Pull request policy", "pass")
)


class FakeGh:
    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)
        self.calls: list[list[str]] = []

    def __call__(self, arguments: Sequence[str]) -> str:
        self.calls.append(list(arguments))
        if arguments[:2] == ["pr", "checks"]:
            return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return ""

    @property
    def merged(self) -> bool:
        return any(call[:2] == ["pr", "merge"] for call in self.calls)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def run(gh: FakeGh, *extra: str) -> tuple[int, str]:
    clock = Clock()
    output = io.StringIO()
    with redirect_stdout(output), redirect_stderr(output):
        status = mwg.main(["31", *extra], runner=gh, sleep=clock.sleep, clock=clock)
    return status, output.getvalue()


class Rulesets(unittest.TestCase):
    def test_the_required_checks_come_from_the_rulesets(self) -> None:
        self.assertEqual(mwg.required_checks(), frozenset({"Gate", "Pull request policy"}))


class Parsing(unittest.TestCase):
    def test_gh_lines_become_checks(self) -> None:
        self.assertEqual(mwg.parse(GREEN)[0], mwg.Check("Gate", "pass"))
        self.assertEqual(len(mwg.parse(GREEN + "\n")), 3)


class Verdicts(unittest.TestCase):
    required = frozenset({"Gate", "Pull request policy"})

    def test_green(self) -> None:
        self.assertTrue(mwg.verdict(mwg.parse(GREEN), self.required).green)

    def test_pending_waits(self) -> None:
        self.assertTrue(mwg.verdict(mwg.parse(PENDING), self.required).waiting)

    def test_a_failure_is_named(self) -> None:
        self.assertEqual(mwg.verdict(mwg.parse(RED), self.required).problems, ("Gate is fail",))

    def test_a_required_check_not_reported_yet_is_waited_for(self) -> None:
        only_policy = mwg.verdict(mwg.parse(checks(("Pull request policy", "pass"))), self.required)
        self.assertTrue(only_policy.waiting)
        self.assertEqual(only_policy.problems, ("Gate has not reported",))

    def test_a_skipped_check_is_not_a_failure(self) -> None:
        skipped = GREEN + checks(("Optional", "skipping"))
        self.assertTrue(mwg.verdict(mwg.parse(skipped), self.required).green)

    def test_nothing_reported_yet_is_waited_for(self) -> None:
        self.assertTrue(mwg.verdict([], self.required).waiting)


class Merging(unittest.TestCase):
    def test_it_waits_then_merges_with_a_merge_commit(self) -> None:
        gh = FakeGh(PENDING, PENDING, GREEN)
        status, output = run(gh)
        self.assertEqual(status, 0)
        self.assertIn(
            ["pr", "merge", "31", "--repo", mwg.REPOSITORY, "--merge", "--delete-branch"], gh.calls
        )
        self.assertIn("#31 merged", output)

    def test_a_red_pull_request_is_never_merged(self) -> None:
        gh = FakeGh(PENDING, RED)
        status, output = run(gh)
        self.assertEqual(status, 1)
        self.assertFalse(gh.merged)
        self.assertIn("Gate is fail", output)

    def test_still_pending_at_the_timeout_is_not_merged(self) -> None:
        gh = FakeGh(PENDING)
        status, output = run(gh, "--timeout-s", "60", "--interval-s", "15")
        self.assertEqual(status, 1)
        self.assertFalse(gh.merged)
        self.assertIn("Gate is pending", output)

    def test_checks_that_appear_late_are_waited_for(self) -> None:
        gh = FakeGh("", "", PENDING, GREEN)
        status, _ = run(gh)
        self.assertEqual(status, 0)
        self.assertTrue(gh.merged)

    def test_a_required_check_that_never_reports_is_named_at_the_timeout(self) -> None:
        gh = FakeGh(checks(("Pull request policy", "pass")))
        status, output = run(gh, "--timeout-s", "30", "--interval-s", "15")
        self.assertEqual(status, 1)
        self.assertFalse(gh.merged)
        self.assertIn("Gate has not reported", output)


if __name__ == "__main__":
    unittest.main()
