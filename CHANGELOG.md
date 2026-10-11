# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html), for the
whole repository
([ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md)).

Each version's entries are written by hand at release time, from the pull
requests it merged.

## [Unreleased]

## [0.2.0] — 2026-10-11

M1 (platform and viability), released with three of its exit criteria still
open: they need the farm's mini-PC and read access to Sky Orchestrator's
packages (see Known limitations). Every unit runs and is tested; where the design
could break, it is measured on the production images.

### Added

- The database: the migration runner with its ledger, checksums and advisory
  lock; schema `soc`'s baseline, the service roles and their SCRAM passwords;
  command intents; each user's live organizations (`soc.member_organizations`);
  a test harness on the production Postgres image with Virtual Origen's contract
  surface, and the real Realtime v2.102.3 beside it (#15, #21, #26, #35).
- Shared Python: the configuration contract and `soc-config`, correlated logs
  (`soc-log`), the one supervised database connection (`soc-db`), the Realtime
  Broadcast client with its HTTP fallback (`soc-realtime`) and the supervision
  every link shares (#18, #19, #20).
- Sky Orchestrator's wire contracts vendored at a pinned commit, held to their
  checksums, pinned to its v0.4.1 release (#22, #28).
- `soc-cloud`: the service skeleton with health and readiness; one MQTT link per
  stack as the cloud client, topology and presence, OSD ingest, `status_reply`;
  flight files answered to the dock's `flighttask_resource_get` and served by
  their token; command intents claimed once and put on the wire (#23, #24, #25,
  #27). Measured on the container lane: commands from commit to the wire under
  50 ms at p95, `flighttask_resource_get` answered under 500 ms at p99.
- `soc-operations`: the service skeleton, with its configuration, health and
  database link (#29).
- The images and the compose project for the mini-PC, read-only, unprivileged,
  within their limits; the service images published to GHCR at each release
  (#32, #33).
- `soc-web`: the toolchain, the tokens and the shell, with the web's gate; sign-in
  with a Virtual Origen account and the organization first; the runtime
  configuration read from `/config.json`; the console's own hardened image; the
  persistent 3D scene, drawn on demand in the theme's tokens, with the map tools
  (#34, #38, #40, #43).
- What Sky Orchestrator's M4 phone session means for SOC (#47).

### Changed

- The tools follow the workspace's lint rules; `uv_build` is held equal across
  units and Node's types follow the runtime's major; the base images stay on the
  lines their records chose; `lucide-react` 1.53.0 (#17, #37, #39, #44).
- `tools/merge_when_green.py` merges only once every check has passed (#31).

### Fixed

- The release workflow can open the back-merge, and says how to check it (#12).
- Each command's latency is measured alone in the lane test (#30).
- The hooks run git on another repository without their own git environment
  (#46).

### Known limitations

- Three of M1's exit criteria stay open, released by decision:
  - Broadcast on Virtual Origen's own Realtime on the mini-PC, through a
    recreate of its container (`DEP-23`): proven on the same versions in
    containers only.
  - `flighttask_resource_get` answered against Sky Orchestrator's own images and
    fake bridge: measured against a dock speaking its contract only.
  - The whole stack's timed bring-up on the mini-PC: each image is checked on its
    own.
- The stack check against Sky Orchestrator's released images waits for read
  access to its packages on GHCR, and the viability session for the box steps
  (`DEP-21`).
- Rulesets are still not applied on the free plan (`RISK-13`).

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
