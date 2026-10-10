# Tools

Repository tooling: deterministic, tested, standard library only, no business
logic. Each answers a question where the same input must always give the same
answer, so it is a script with tests rather than a judgement made each time
(`NFR-MNT-05`).

| Tool | Purpose | Tests |
| --- | --- | --- |
| [`lint_commits.py`](lint_commits.py) | The commit convention of [ADR-0003](../docs/architecture/decisions/0003-git-flow-and-conventional-commits.md) | [`test_lint_commits.py`](tests/test_lint_commits.py) |
| [`check_branch.py`](check_branch.py) | Branch names and Git Flow direction | [`test_check_branch.py`](tests/test_check_branch.py) |
| [`next_version.py`](next_version.py) | The next version, suggested and verified | [`test_next_version.py`](tests/test_next_version.py) |
| [`check_links.py`](check_links.py) | Every relative Markdown link resolves | [`test_check_links.py`](tests/test_check_links.py) |
| [`prune_branches.py`](prune_branches.py) | Local branches whose merged remote was deleted, deleted safely | [`test_prune_branches.py`](tests/test_prune_branches.py) |
| [`setup_github.sh`](setup_github.sh) | Applies the [governance](../docs/github-governance.md) | Idempotent; `--dry-run` shows the plan |
| [`tests/test_workflows.py`](tests/test_workflows.py) | Holds the workflows to the [minutes budget](../docs/ci-cd.md#minutes-budget) and to safe scripting | Itself |

The commit linter, the branch checker and the link checker run identically in
the pre-commit hooks and in CI.

The tools run on the system `python3`, 3.12 or newer, with nothing installed:
ruff and mypy hold them to Python 3.12 while the workspace targets 3.14, and CI
runs their tests on 3.12.

```bash
python3 -m unittest discover -s tools/tests -v
python3 tools/lint_commits.py --message "feat(tools): add the link checker"
python3 tools/check_branch.py --branch feature/web/fleet-panel --base develop
python3 tools/next_version.py
python3 tools/prune_branches.py --dry-run
tools/setup_github.sh --dry-run
```

Every tool lands with its tests in the same commit.
