from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_branch as cb
from lint_commits import SCOPES


class Names(unittest.TestCase):
    def test_protected_branches_are_valid(self) -> None:
        for branch in ("main", "develop"):
            with self.subTest(branch=branch):
                self.assertEqual(cb.check_name(branch), [])

    def test_work_branches_with_every_scope(self) -> None:
        for kind in ("feature", "bugfix"):
            for scope in SCOPES:
                with self.subTest(kind=kind, scope=scope):
                    self.assertEqual(cb.check_name(f"{kind}/{scope}/some-work"), [])

    def test_versioned_branches_declare_a_version(self) -> None:
        for branch in ("release/v0.2.0", "hotfix/v1.0.1", "backmerge/v0.1.0"):
            with self.subTest(branch=branch):
                self.assertEqual(cb.check_name(branch), [])

    def test_a_versioned_branch_without_a_version_is_refused(self) -> None:
        for branch in ("release/next", "release/0.2.0", "hotfix/v1.0"):
            with self.subTest(branch=branch):
                self.assertTrue(cb.check_name(branch))

    def test_an_unknown_scope_is_refused(self) -> None:
        problems = cb.check_name("feature/backend/some-work")
        self.assertTrue(any("not an allowed scope" in problem for problem in problems))

    def test_malformed_work_branches_are_refused(self) -> None:
        for branch in ("feature/fleet-panel", "feature/web/FleetPanel", "feat/web/x", "wip"):
            with self.subTest(branch=branch):
                self.assertTrue(cb.check_name(branch))

    def test_dependabot_branches(self) -> None:
        for branch in (
            "dependabot/github_actions/actions/checkout-6",
            "dependabot/npm_and_yarn/apps/soc-web/three-0.180.0",
            "dependabot/uv/services/soc-cloud/aiomqtt-2.5.0",
        ):
            with self.subTest(branch=branch):
                self.assertEqual(cb.check_name(branch), [])

    def test_names_dependabot_would_not_write(self) -> None:
        for branch in ("dependabot", "dependabot/", "dependabot/uv", "dependabot/x/../main"):
            with self.subTest(branch=branch):
                self.assertTrue(cb.check_name(branch))


class Direction(unittest.TestCase):
    def test_main_accepts_develop_releases_and_hotfixes(self) -> None:
        for head in ("develop", "release/v0.2.0", "hotfix/v0.1.1"):
            with self.subTest(head=head):
                self.assertEqual(cb.check_direction(head, "main"), [])

    def test_main_refuses_work_branches(self) -> None:
        for head in ("feature/web/x", "bugfix/cloud/x", "backmerge/v0.1.0"):
            with self.subTest(head=head):
                self.assertTrue(cb.check_direction(head, "main"))

    def test_develop_accepts_its_sources(self) -> None:
        for head in (
            "feature/web/x",
            "bugfix/cloud/x",
            "release/v0.2.0",
            "hotfix/v0.1.1",
            "backmerge/v0.2.0",
            "dependabot/uv/x/y",
        ):
            with self.subTest(head=head):
                self.assertEqual(cb.check_direction(head, "develop"), [])

    def test_main_is_never_a_head(self) -> None:
        for base in ("develop", "anything-else"):
            with self.subTest(base=base):
                self.assertTrue(cb.check_direction("main", base))

    def test_unprotected_bases_have_no_rule(self) -> None:
        self.assertEqual(cb.check_direction("feature/web/x", "feature/web/y"), [])


class CommandLine(unittest.TestCase):
    def status(self, arguments: list[str]) -> int:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return cb.main(arguments)

    def test_exit_status(self) -> None:
        self.assertEqual(self.status(["--branch", "feature/web/x", "--base", "develop"]), 0)
        self.assertEqual(self.status(["--branch", "feature/web/x", "--base", "main"]), 1)
        self.assertEqual(self.status(["--branch", "feature/unknown/x"]), 1)


if __name__ == "__main__":
    unittest.main()
