# ADR-0003 — Git Flow with scoped one-line conventional commits

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

SOC is released as one system onto one mini-PC, and a release is the thing that
gets flown with. Work happens in parallel across units, often by several agent
sessions. History must answer "what changed in `soc-cloud` between these two
flights" without archaeology, and review happens by walking a sequence of
commits, not by reading one final diff.

Sky Orchestrator settled the same questions with ADR-0007 there. SOC follows it,
with the two differences named below.

## Decision

**Git Flow**: `main` (released, tagged), `develop` (integration, the default
branch), `feature/<scope>/<slug>` and `bugfix/<scope>/<slug>` from `develop`,
`release/vX.Y.Z` from `develop` into `main`, `hotfix/vX.Y.Z` from `main`, and a
throwaway `backmerge/vX.Y.Z` cut from `main` to carry a release back.

**Conventional Commits with a mandatory scope** from a closed list:
`web`, `cloud`, `operations`, `libs`, `database`, `contracts`, `infra`, `tools`,
`repo`. `docs` and `ci` are types, not scopes: `docs(cloud)` says what was
documented.

**A commit message is exactly one line**, in English, imperative, lower case
start, no trailing full stop, 10 to 72 characters of subject. No body, no
footers, no trailers, no `Co-authored-by`. Everything a body would carry goes in
the pull request description, which is where review happens.

**Commits are small, one domain each, and ordered so every commit stands on its
own**: no broken import, no reference to a file that arrives later. Tests land
with the code they test.

**Nothing reaches `main` or `develop` except through a pull request.**

**Merge commits everywhere.** This is the first difference from Sky
Orchestrator's written rule: SOC never squashes. A pull request is a sequence of
small domain commits on purpose, and squashing would erase exactly the history
that sequence exists to keep. Sky Orchestrator's history converged on the same
practice.

**Versions are tagged automatically** from the release or hotfix branch name
when its pull request merges into `main`, after a tool has checked the version
against the commits since the last tag. Platform-level versioning: one `vX.Y.Z`
for the whole repository.

**Enforced, not documented.** `tools/lint_commits.py` and `tools/check_branch.py`
run as pre-commit hooks and in the pull request policy check. The second
difference from Sky Orchestrator: the scope list is SOC's.

## Alternatives considered

**Trunk-based development.** Simpler. Rejected for the reason Sky Orchestrator
gave: a release is what gets cleared to fly, and it needs a branch to stabilise
on.

**Squash merges into `develop`.** One linted line per pull request. Rejected:
the small, ordered commits are the review artefact, and they would not survive.

**Commit bodies carrying the rationale.** Rejected: nobody can reply to a commit
message, and a squash or a rebase loses it. The pull request description is
editable and survives.

## Consequences

- `git log --oneline` is a complete, readable index of the project.
- The pull request description is load-bearing; its template asks for the
  requirements touched, the evidence and the failure modes.
- The linter will reject commits. That is the mechanism working; `--no-verify`
  is not an escape hatch.
