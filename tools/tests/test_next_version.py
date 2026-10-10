from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import next_version as nv
from next_version import Bump, Version


class FakeRepository(nv.Repository):
    def __init__(self, tag: str | None, subjects: list[str]) -> None:
        self.tag = Version.parse(tag) if tag else None
        self.subjects = subjects

    def latest_tag(self) -> Version | None:
        return self.tag

    def subjects_since(self, tag: Version | None) -> list[str]:
        return self.subjects


def run(arguments: list[str], tag: str | None, subjects: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with redirect_stdout(output), redirect_stderr(io.StringIO()):
        status = nv.main(arguments, FakeRepository(tag, subjects))
    return status, output.getvalue().strip()


class Parsing(unittest.TestCase):
    def test_valid_versions(self) -> None:
        self.assertEqual(Version.parse("v0.1.0"), Version(0, 1, 0))
        self.assertEqual(Version.parse("v12.34.56"), Version(12, 34, 56))

    def test_invalid_versions(self) -> None:
        for text in ("0.1.0", "v0.1", "v01.0.0", "v0.1.0-rc1", "vx.y.z"):
            with self.subTest(text=text):
                self.assertIsNone(Version.parse(text))

    def test_branches_declare_their_version(self) -> None:
        for branch in ("release/v0.2.0", "hotfix/v0.2.0", "backmerge/v0.2.0"):
            with self.subTest(branch=branch):
                self.assertEqual(Version.from_branch(branch), Version(0, 2, 0))

    def test_other_branches_declare_nothing(self) -> None:
        for branch in ("feature/web/x", "release/0.2.0", "release/next", "main"):
            with self.subTest(branch=branch):
                self.assertIsNone(Version.from_branch(branch))

    def test_ordering_is_numeric(self) -> None:
        self.assertLess(Version(0, 9, 0), Version(0, 10, 0))


class BumpLevel(unittest.TestCase):
    def test_fixes_and_chores_are_a_patch(self) -> None:
        self.assertIs(nv.bump_for(["fix(cloud): a fix here", "docs(repo): some docs"]), Bump.PATCH)

    def test_a_feature_is_a_minor(self) -> None:
        self.assertIs(nv.bump_for(["fix(cloud): a fix here", "feat(web): a feature"]), Bump.MINOR)

    def test_a_breaking_change_is_a_major_whatever_its_type(self) -> None:
        self.assertIs(nv.bump_for(["fix(contracts)!: rename a field"]), Bump.MAJOR)

    def test_unparseable_subjects_imply_nothing(self) -> None:
        self.assertIs(nv.bump_for(["Merge pull request #3 from x/y", "wip"]), Bump.PATCH)


class Suggestion(unittest.TestCase):
    def test_the_first_release(self) -> None:
        self.assertEqual(nv.suggest(None, ["feat(web): anything at all"]), Version(0, 1, 0))

    def test_below_one_every_level_shifts_down(self) -> None:
        current = Version(0, 3, 1)
        self.assertEqual(current.bumped(Bump.MAJOR), Version(0, 4, 0))
        self.assertEqual(current.bumped(Bump.MINOR), Version(0, 3, 2))
        self.assertEqual(current.bumped(Bump.PATCH), Version(0, 3, 2))

    def test_from_one_on_levels_apply_as_named(self) -> None:
        current = Version(1, 2, 3)
        self.assertEqual(current.bumped(Bump.MAJOR), Version(2, 0, 0))
        self.assertEqual(current.bumped(Bump.MINOR), Version(1, 3, 0))
        self.assertEqual(current.bumped(Bump.PATCH), Version(1, 2, 4))


class Verification(unittest.TestCase):
    def test_a_version_not_above_the_latest_tag_is_refused(self) -> None:
        self.assertTrue(nv.problems_with(Version(0, 2, 0), Version(0, 2, 0), []))

    def test_a_bump_smaller_than_the_commits_require_is_refused(self) -> None:
        subjects = ["feat(web)!: replace the scene graph"]
        self.assertTrue(nv.problems_with(Version(0, 2, 1), Version(0, 2, 0), subjects))
        self.assertEqual(nv.problems_with(Version(0, 3, 0), Version(0, 2, 0), subjects), [])

    def test_a_larger_bump_than_needed_is_allowed(self) -> None:
        self.assertEqual(nv.problems_with(Version(1, 0, 0), Version(0, 2, 0), []), [])


class CommandLine(unittest.TestCase):
    def test_it_suggests_from_the_commits(self) -> None:
        self.assertEqual(run([], "v0.1.0", ["feat(web): a feature"]), (0, "v0.1.1"))

    def test_it_prints_the_current_tag(self) -> None:
        self.assertEqual(run(["--current"], None, []), (0, "none"))
        self.assertEqual(run(["--current"], "v0.4.0", []), (0, "v0.4.0"))

    def test_a_branch_with_an_admissible_version_passes(self) -> None:
        self.assertEqual(run(["--branch", "release/v0.2.0"], "v0.1.0", []), (0, "v0.2.0"))

    def test_a_branch_without_a_version_fails(self) -> None:
        self.assertEqual(run(["--branch", "feature/web/x"], "v0.1.0", [])[0], 1)

    def test_an_inadmissible_version_fails(self) -> None:
        self.assertEqual(run(["--verify", "v0.1.0"], "v0.1.0", [])[0], 1)
        self.assertEqual(run(["--verify", "0.2.0"], "v0.1.0", [])[0], 1)


if __name__ == "__main__":
    unittest.main()
