from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lint_commits  # noqa: E402
from lint_commits import Commit  # noqa: E402


def rules(message: str) -> set[str]:
    return {problem.rule for problem in lint_commits.lint(message)}


class ValidMessages(unittest.TestCase):
    def test_a_minimal_header_is_valid(self) -> None:
        self.assertEqual(rules("feat(cloud): answer the dock's resource request"), set())

    def test_every_type_is_accepted(self) -> None:
        for commit_type in lint_commits.TYPES:
            with self.subTest(type=commit_type):
                self.assertEqual(rules(f"{commit_type}(web): change the fleet panel layout"), set())

    def test_every_scope_is_accepted(self) -> None:
        for scope in lint_commits.SCOPES:
            with self.subTest(scope=scope):
                self.assertEqual(rules(f"feat({scope}): add something long enough"), set())

    def test_the_breaking_marker_needs_no_footer(self) -> None:
        self.assertEqual(rules("feat(contracts)!: rename the telemetry broadcast event"), set())

    def test_trailing_blank_lines_are_not_a_body(self) -> None:
        self.assertEqual(rules("feat(operations): add the operation states\n\n\n"), set())

    def test_subject_lengths_at_both_bounds(self) -> None:
        for length in (lint_commits.MIN_SUBJECT, lint_commits.MAX_SUBJECT):
            with self.subTest(length=length):
                self.assertEqual(rules(f"feat(web): {'a' * length}"), set())

    def test_a_subject_may_start_with_a_digit(self) -> None:
        self.assertEqual(rules("chore(infra): 12-factor the compose configuration"), set())


class GitGeneratedMessages(unittest.TestCase):
    def test_merges_are_exempt(self) -> None:
        for header in (
            "Merge branch 'develop' into feature/web/fleet-panel",
            "Merge remote-tracking branch 'origin/develop'",
            "Merge pull request #12 from SergioDeIscarValera/feature/web/x",
            "Merge tag 'v0.1.0' into develop",
        ):
            with self.subTest(header=header):
                self.assertEqual(rules(header), set())

    def test_a_merge_body_is_exempt_from_the_single_line_rule(self) -> None:
        message = "Merge pull request #12 from owner/release/v0.1.0\n\nrelease: v0.1.0"
        self.assertEqual(rules(message), set())

    def test_reverts_and_autosquash_markers_are_exempt(self) -> None:
        for message in (
            'Revert "feat(web): add the fleet panel"\n\nThis reverts commit abc123.',
            "fixup! feat(web): add the fleet panel",
            "squash! feat(web): add the fleet panel",
            "amend! feat(web): add the fleet panel",
        ):
            with self.subTest(message=message):
                self.assertEqual(rules(message), set())


class RejectedMessages(unittest.TestCase):
    def test_an_empty_message(self) -> None:
        self.assertEqual(rules("   \n  \n"), {"empty"})

    def test_a_missing_scope(self) -> None:
        self.assertIn("header-format", rules("feat: answer the dock's resource request"))

    def test_a_missing_space_after_the_colon(self) -> None:
        self.assertIn("header-format", rules("feat(cloud):answer the resource request"))

    def test_an_unknown_type(self) -> None:
        self.assertIn("type", rules("feature(cloud): answer the resource request"))

    def test_an_unknown_scope(self) -> None:
        self.assertIn("scope", rules("feat(backend): answer the resource request"))

    def test_an_upper_case_subject(self) -> None:
        self.assertIn("subject-case", rules("feat(cloud): Answer the resource request"))

    def test_a_trailing_period(self) -> None:
        self.assertIn("subject-period", rules("feat(cloud): answer the resource request."))

    def test_subjects_outside_the_length_bounds(self) -> None:
        for length in (lint_commits.MIN_SUBJECT - 1, lint_commits.MAX_SUBJECT + 1):
            with self.subTest(length=length):
                self.assertIn("subject-length", rules(f"feat(web): {'a' * length}"))

    def test_a_header_over_the_maximum(self) -> None:
        self.assertIn("header-length", rules(f"feat(web): {'a' * lint_commits.MAX_HEADER}"))

    def test_a_body_is_refused(self) -> None:
        for message in (
            "feat(cloud): answer the resource request\nthe body starts here",
            "feat(cloud): answer the resource request\n\nexplanatory paragraph",
            "feat(cloud): answer the resource request\n\nRefs: FR-OPS-01",
        ):
            with self.subTest(message=message):
                self.assertIn("single-line", rules(message))

    def test_co_author_trailers_are_refused_in_any_case(self) -> None:
        for trailer in ("Co-Authored-By: Someone <a@b.c>", "co-authored-by: someone <a@b.c>"):
            with self.subTest(trailer=trailer):
                self.assertIn("co-author", rules(f"feat(web): add the fleet panel\n\n{trailer}"))

    def test_every_problem_is_reported_at_once(self) -> None:
        self.assertEqual(
            rules("feature(backend): Do it."),
            {"type", "scope", "subject-case", "subject-period", "subject-length"},
        )


class GitComments(unittest.TestCase):
    def test_comment_lines_are_ignored(self) -> None:
        message = (
            "feat(web): add the fleet panel\n\n"
            "# Please enter the commit message for your changes.\n"
            "# On branch feature/web/fleet-panel\n"
        )
        self.assertEqual(rules(message), set())

    def test_the_verbose_scissors_section_is_dropped(self) -> None:
        message = (
            "feat(web): add the fleet panel\n\n"
            f"{lint_commits.SCISSORS}\n"
            "diff --git a/x b/x\n"
        )
        self.assertEqual(rules(message), set())

    def test_a_message_of_comments_only_is_empty(self) -> None:
        self.assertEqual(rules("# nothing here\n# nor here\n"), {"empty"})


class Dependabot(unittest.TestCase):
    MESSAGE = (
        "ci(repo): bump actions/checkout from 5 to 6\n\n"
        "Bumps [actions/checkout](https://github.com/actions/checkout) from 5 to 6.\n\n"
        "Signed-off-by: dependabot[bot] <support@github.com>\n"
    )

    def test_dependabot_may_write_a_body(self) -> None:
        commit = Commit("f" * 40, lint_commits.DEPENDABOT_AUTHOR, self.MESSAGE)
        self.assertEqual(lint_commits.lint_commit(commit), [])

    def test_dependabot_is_still_held_to_the_header(self) -> None:
        message = self.MESSAGE.replace("ci(repo)", "build(ci)")
        commit = Commit("f" * 40, lint_commits.DEPENDABOT_AUTHOR, message)
        self.assertEqual([problem.rule for problem in lint_commits.lint_commit(commit)], ["scope"])

    def test_anyone_else_with_a_body_is_refused(self) -> None:
        commit = Commit("f" * 40, "someone@example.com", self.MESSAGE)
        self.assertEqual(
            [problem.rule for problem in lint_commits.lint_commit(commit)], ["single-line"]
        )


class CommandLine(unittest.TestCase):
    def test_a_valid_message_exits_zero(self) -> None:
        self.assertEqual(lint_commits.main(["--message", "feat(web): add the fleet panel"]), 0)

    def test_an_invalid_message_exits_one(self) -> None:
        self.assertEqual(lint_commits.main(["--message", "nope"]), 1)

    def test_a_message_file_is_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "COMMIT_EDITMSG"
            path.write_text("fix(cloud): answer the resource request in time\n", encoding="utf-8")
            self.assertEqual(lint_commits.main(["--file", str(path)]), 0)

    def test_a_range_fails_on_any_rejected_commit(self) -> None:
        commits = [
            Commit("a" * 40, "a@b.c", "feat(web): add the fleet panel"),
            Commit("b" * 40, "a@b.c", "wip"),
        ]
        with mock.patch.object(lint_commits, "commits_in_range", return_value=commits):
            self.assertEqual(lint_commits.main(["--range", "a..b"]), 1)

    def test_a_clean_range_passes(self) -> None:
        commits = [Commit("a" * 40, "a@b.c", "feat(web): add the fleet panel")]
        with mock.patch.object(lint_commits, "commits_in_range", return_value=commits):
            self.assertEqual(lint_commits.main(["--range", "a..b"]), 0)


if __name__ == "__main__":
    unittest.main()
