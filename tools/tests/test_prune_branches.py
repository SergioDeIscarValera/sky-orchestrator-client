from __future__ import annotations

import io
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prune_branches as pb

REFS = "\n".join(
    (
        " |main|",
        " |develop|",
        "*|feature/web/current|[gone]",
        " |feature/web/merged|[gone]",
        " |feature/cloud/unmerged|[gone]",
        " |feature/web/alive|[ahead 2]",
        " |local-only|",
    )
)


class FakeGit:
    def __init__(self, unmerged: frozenset[str] = frozenset()) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.unmerged = unmerged

    def __call__(self, *arguments: str) -> str:
        self.calls.append(arguments)
        if arguments[0] == "for-each-ref":
            return REFS
        if arguments[:2] == ("branch", "-d") and arguments[2] in self.unmerged:
            raise subprocess.CalledProcessError(1, "git", stderr="error: not fully merged")
        return ""

    def deleted(self) -> list[str]:
        return [call[2] for call in self.calls if call[:2] == ("branch", "-d")]


def run(arguments: list[str], git: FakeGit) -> int:
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        return pb.main(arguments, git)


class Candidates(unittest.TestCase):
    def test_only_branches_whose_upstream_is_gone(self) -> None:
        names = pb.candidates(pb.local_branches(FakeGit()))
        self.assertEqual(names, ["feature/web/merged", "feature/cloud/unmerged"])

    def test_protected_and_current_branches_are_never_candidates(self) -> None:
        branches = [
            pb.LocalBranch("main", upstream_gone=True, current=False),
            pb.LocalBranch("develop", upstream_gone=True, current=False),
            pb.LocalBranch("feature/web/x", upstream_gone=True, current=True),
        ]
        self.assertEqual(pb.candidates(branches), [])


class Pruning(unittest.TestCase):
    def test_it_fetches_with_pruning_first(self) -> None:
        git = FakeGit()
        run([], git)
        self.assertEqual(git.calls[0], ("fetch", "--prune", "--quiet"))

    def test_merged_branches_are_deleted_safely(self) -> None:
        git = FakeGit()
        self.assertEqual(run([], git), 0)
        self.assertEqual(git.deleted(), ["feature/web/merged", "feature/cloud/unmerged"])

    def test_an_unmerged_branch_is_kept_and_reported(self) -> None:
        git = FakeGit(unmerged=frozenset({"feature/cloud/unmerged"}))
        self.assertEqual(run([], git), 1)

    def test_a_dry_run_deletes_nothing(self) -> None:
        git = FakeGit()
        self.assertEqual(run(["--dry-run"], git), 0)
        self.assertEqual(git.deleted(), [])


if __name__ == "__main__":
    unittest.main()
