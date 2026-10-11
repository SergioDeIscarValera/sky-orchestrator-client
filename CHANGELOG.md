# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html), for the
whole repository
([ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md)).

Each version's entries are written by hand at release time, from the pull
requests it merged.

## [Unreleased]

## [0.3.0] — 2026-10-11

M2 (live fleet) closed: a registered aircraft's live telemetry in 3D, on the
farm's terrain. Its five exit criteria are measured through the console itself,
in Chrome, by the console end to end (#82).

### Added

- The aircraft catalogue, sourced figure by figure, and its loading migration;
  stacks, devices and fleets in the database, with their policies, each stack
  naming the organization it flies for (#45, #48, #50).
- `soc-cloud`: each stack's link, devices and firmware recorded for the console;
  every telemetry sample fanned out to its organization's members over Realtime
  Broadcast; the latencies it can see logged every minute (#51, #52, #53).
- `soc-geo`: the local frame, the east-north tangent plane at the organization,
  and its inverse, held to golden vectors from PROJ (#66).
- Sky Orchestrator's v0.4.2 contracts vendored: real flight behind two keys,
  deadlines with `319999` as an unknown outcome, `media_count` (#68).
- The console:
  - the panels opened from the rail, the view kept in the URL (#54);
  - fleets read and written through Supabase and kept live from the state
    topic; the fleet panel and the inspector; registering, editing and retiring
    fleets (#55, #56, #60);
  - its own configuration file, checked before it starts (#61);
  - each aircraft's live telemetry with its age, stale and lost at the
    thresholds (#62);
  - the organization's aircraft in the scene, gliding between samples; selected,
    labelled and framed beside the inspector; pinned and followed (#70, #72, #73);
  - the farm's baked terrain, tinted, with contours and two levels of detail,
    and the aircraft flying at their takeoff point's ground plus their height,
    the takeoff point shown in the inspector (#77, #79);
  - the camera and its target kept over the terrain (#81);
  - the favicon drawn from the tokens; `pnpm demo` against a fake Supabase;
    telemetry's delivery at p95 in `?stats`; `pnpm measure`, the frame time on
    the production build along a scripted path (#69, #71, #74, #80).
- `soc-site`: a site model fetched from IGN once and baked offline, the same
  bytes every time, within 8 MB (Finca Norte's 3.1 MB); served read-only by the
  console's image at `/site/<organization>/` (#75, #78).
- `infra/e2e`: the console end to end in CI, on Virtual Origen's platform behind
  Kong, with `soc-cloud`, a dock speaking Sky Orchestrator's contract and the
  console's image, worked in Chrome (#82).

### Changed

- Every CI job runs on `ubuntu-24.04`; the change detectors read the changed
  paths from a variable, and every web check runs (#49, #76).
- The web's test files share their worker's modules: the suite in CI from 10.7 s
  to 2.8 s (#59).
- Sky Orchestrator's real-flight unlock, its simulator check and `316010`, the
  phone's own envelope, the phone's configuration fingerprint of the simulated
  pass and an execute answered `319999` recorded for M4 (#57, #58, #63, #65,
  #67).

### Fixed

- `tools/merge_when_green.py` reports a merge only once GitHub says the pull
  request is merged (#64).

### Measured

- An aircraft announced appears in the console 87 to 423 ms later, and is
  registered through its form (`FR-FLE-02`, `FR-FLE-03`, within 2 s).
- Telemetry from the dock's publish to Chrome: 28 ms at p95 and 45 ms at p99
  over ten minutes at 5 Hz, 3,002 samples in order (`NFR-PERF-01`, 150 and
  300 ms).
- A silent dock reads Stale 2,993 to 3,001 ms after the last sample (`FR-TEL-02`,
  3,000 ms ± 100).
- The frame time along the scripted 60 s path with two aircraft at 1920×1080:
  17.6 ms at p95 on an Intel UHD below the operator's laptop class
  (`NFR-PERF-06`, 20 ms).

### Known limitations

- Against Sky Orchestrator's own images: a dock speaking its contract stands in
  until SOC can read its packages on GHCR.
- On the mini-PC: nothing is measured on the box yet (`DEP-21`).
- A ridge between the camera and its target can hide the target; the camera
  stays above the ground.
- `?stats` shows no GPU memory in bytes.

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
