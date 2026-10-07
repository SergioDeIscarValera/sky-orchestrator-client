# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html), for the
whole repository
([ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md)).

Each version's entries are written by hand at release time, from the pull
requests it merged.

## [Unreleased]

### Added

- Repository tooling with gate tests: commit linter, branch and Git Flow checker,
  version suggestion and verification, Markdown link checker, traceability check,
  local branch pruning.
- Pipelines: the gate, the pull request policy, release tagging with the
  back-merge, Dependabot.
- Governance: rulesets ready to apply, the setup script, merge commits only,
  merged branches deleted automatically, pre-commit hooks, templates.
- Decision records 0001 to 0018, the design system, the risk register, the
  roadmap, the requirements (FR, NFR, IR), the glossary, the dependency register
  and the traceability matrix.
