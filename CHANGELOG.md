# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html), for the
whole repository
([ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md)).

Each version's entries are written by hand at release time, from the pull
requests it merged.

## [Unreleased]

## [0.1.0] — 2026-10-07

M0 (foundations) closed: the repository, its conventions and pipelines, and the
documents everything after it is built against. No unit runs yet.

### Added

- Repository tooling with gate tests: commit linter, branch and Git Flow checker,
  version suggestion and verification, Markdown link checker, traceability check,
  local branch pruning.
- Pipelines: the gate, the pull request policy, release tagging with the
  back-merge, Dependabot.
- Governance: rulesets ready to apply, the setup script, merge commits only,
  merged branches deleted automatically, pre-commit hooks, templates.
- Decision records 0001 to 0018, the design system, the risk register, the
  roadmap, the requirements (157 FR and NFR, the IR, assumptions and
  constraints), the glossary, the dependency register and the traceability
  matrix, held equal to the requirements by a check.
- The README, the architecture overview and the scaffolding of every unit.

### Known limitations

- Rulesets cannot be applied to a private repository on the free plan: the
  checks run on every pull request but are not required (`RISK-13`).
