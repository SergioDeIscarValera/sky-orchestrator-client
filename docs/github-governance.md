# GitHub governance

The repository's rules as configuration rather than habit: version-controlled,
reviewed like any change, applied by one idempotent script.

```bash
tools/setup_github.sh --dry-run    # what would be applied
tools/setup_github.sh              # apply
```

The branching model is argued in
[ADR-0003](architecture/decisions/0003-git-flow-and-conventional-commits.md);
day-to-day use is in [CONTRIBUTING](../CONTRIBUTING.md).

---

## Current state: rulesets not applied

**The repository is private on GitHub's free plan, which offers neither rulesets
nor classic branch protection** (`CON-09`). Applied on 2026-10-07:

| Setting | Applied |
| --- | --- |
| Merge commits only (squash and rebase disabled) | Yes |
| Merged branches deleted automatically | Yes |
| Default branch `develop` | Yes |
| Labels for the release notes | Yes |
| Branch rulesets for `main` and `develop` | **No**, refused by the plan |
| Tag ruleset for `v*` | **No**, refused by the plan |

What that costs, stated plainly:

- Nothing server side prevents a direct push to `main` or `develop`.
- Required checks are not required: a pull request can be merged red.
- Version tags are not protected and could be moved (`RISK-13`).

What still holds:

- The pre-commit hooks refuse commits on `main` and `develop` and messages that
  break the convention. They are local: a fresh clone has none until
  `pre-commit install` runs.
- The gate and the pull request policy run on every pull request. Their results
  are visible, not blocking.

The rulesets stay in [`.github/rulesets/`](../.github/rulesets/), ready. Making
the repository public or moving to GitHub Pro closes the gap with one run of
`tools/setup_github.sh`.

---

## What enforces what

| Mechanism | Enforces | Lives in |
| --- | --- | --- |
| Rulesets (server side) | Pull request required, no force push, no deletion, merge method, required checks | [`.github/rulesets/`](../.github/rulesets/) |
| Workflows | Git Flow direction, branch names, title and commits, description, version admissibility | [`.github/workflows/`](../.github/workflows/) |
| Pre-commit hooks | The same rules before the push | [`.pre-commit-config.yaml`](../.pre-commit-config.yaml) |
| Repository settings | Merge methods, automatic branch deletion, default branch | `tools/setup_github.sh` |

Rulesets can say which branch a pull request targets, never which it comes from:
Git Flow direction is a source rule, so it is a workflow check.

## Branch rules, once the rulesets apply

| Rule | `main` | `develop` |
| --- | --- | --- |
| Direct pushes | Blocked | Blocked |
| Accepted sources | `develop`, `release/*`, `hotfix/*` | `feature/*`, `bugfix/*`, `release/*`, `hotfix/*`, `backmerge/*`, `dependabot/*` |
| Merge method | Merge commit | Merge commit |
| Required checks | `Gate`, `Pull request policy`, up to date | The same |
| Force push, deletion | Blocked | Blocked |
| Review threads | Resolved before merge | Resolved before merge |

Tags `v*` cannot be deleted, updated or moved: a released version points at one
commit forever.

## Automatic behaviour

| Behaviour | Mechanism |
| --- | --- |
| Head branch deleted on merge | Repository setting |
| Local copies of deleted branches removed | `tools/prune_branches.py`, run by hand |
| Version tagged on release | `release.yml`, from the branch name |
| GitHub release with notes | `release.yml`, notes grouped by label |
| Back-merge pull request opened | `release.yml`, from a throwaway `backmerge/vX.Y.Z` |
| Changelog label from the title | `pr-policy.yml`, advisory |

## Approvals with one maintainer

`required_approving_review_count` is 0: GitHub does not let an author approve
their own pull request, so requiring one would block every merge. Raise it to 1
when a second person has write access.

## Bypass

`bypass_actors` is empty in every ruleset, administrators included. An emergency
change disables the ruleset, makes the change, and enables it again: that leaves
a trace, a bypass does not.
