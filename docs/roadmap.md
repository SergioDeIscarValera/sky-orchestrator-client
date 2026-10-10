# Roadmap

Milestones are ordered by **risk retired per unit of work**. The first build
milestone, M1, exists to answer the questions that could invalidate the design
cheaply: whether Realtime Broadcast works on Virtual Origen's stack as SOC needs
it, whether SOC can play Sky Orchestrator's cloud party within its deadlines, and
whether the 3D scene fits its budgets on the operator's laptop.

Each milestone ends in a release, and each line of its plan is one pull request
made of small commits, one domain each ([ADR-0003](architecture/decisions/0003-git-flow-and-conventional-commits.md)).
Each milestone has **exit criteria**: falsifiable statements, not a feeling of
progress. A milestone is closed when every criterion is demonstrated.

The MVP is M5: **a first real flight commanded from SOC**
([ADR-0013](architecture/decisions/0013-narrow-vertical-slice-for-the-mvp.md)).

| Milestone | Release | Outcome |
| --- | --- | --- |
| M0 Foundations | v0.1.0 | Repository, conventions, pipelines, requirements, decisions |
| M1 Platform and viability | v0.2.0 | Every unit runs, measured where the design could break |
| M2 Live fleet | v0.3.0 | A registered aircraft's live telemetry in 3D, on the farm's terrain |
| M3 Mission design | v0.4.0 | Geofences and waylines drawn, baked, validated, turned into files SO accepts |
| M4 Operations | v0.5.0 | A whole operation flown from the web against SO's fake bridge |
| M5 First real flight | v0.6.0 | **MVP**: the same, with the real aircraft |

---

## M0 — Foundations · *closed 2026-10-07, v0.1.0*

| Step | Pull request |
| --- | --- |
| Commit message and Markdown link checks | `feature/tools/commit-and-link-checks` |
| Branch name, Git Flow direction and version checks | `feature/tools/branch-and-version-checks` |
| Pipelines: the gate, the pull request policy, releases, Dependabot | `feature/repo/ci-pipelines` |
| Decision records | `feature/repo/decision-records` |
| Governance: rulesets, setup script, hooks, templates, branch pruning, contributing guide | `feature/repo/governance` |
| Design system | `feature/repo/design-system` |
| Risks and roadmap | `feature/repo/risks-and-roadmap` |
| Requirements: functional, non-functional, information, glossary, dependencies, traceability | `feature/repo/requirements` |
| Project overview: README, changelog, architecture, unit scaffolding | `feature/repo/project-overview` |

**Exit criteria**

- [x] FR, NFR and IR documented, each requirement with acceptance criteria: 157 FR and NFR, 17 IR entities
- [x] A decision record for every architectural choice made so far: ADR-0001 to ADR-0018
- [x] Risk register with a trigger per risk: 16 risks
- [x] Dependencies on Sky Orchestrator and Virtual Origen recorded with their identifiers: DEP-01 to DEP-25, three already delivered by SO
- [x] Git Flow branches, merge-commit-only merging and automatic deletion of merged branches, plus `tools/prune_branches.py` for local copies
- [x] Commit, branch and version rules enforced locally and in CI, with their own tests: 113 tooling tests
- [x] Repository hygiene: ignore rules, attributes, editor configuration, templates
- [x] Branch protection configured, or its absence recorded with its cost (`CON-09`): rulesets written and refused by the free plan, recorded in the governance document and `RISK-13`
- [x] Every dependency version chosen in a decision record (`NFR-PORT-02`): ADR-0016 and ADR-0017, smoke-built before being written

---

## M1 — Platform and viability · v0.2.0

| Step | Pull request |
| --- | --- |
| Migration runner, schema `soc` baseline, database test harness with VO2's contract surface | `feature/database/soc-baseline`, merged (#15) |
| Shared Python: the configuration contract and its loader, correlated logs | `feature/libs/config-and-logs` |
| Shared Python: the one database connection, with `LISTEN`, claims and `COPY` | `feature/libs/database-connection` |
| Shared Python: the Realtime Broadcast client, with its HTTP fallback | `feature/libs/realtime-client` |
| `soc-cloud` skeleton: one link per stack, topology, OSD ingest, devices, the file server, health | `feature/cloud/link-skeleton` |
| `soc-operations` skeleton: configuration, health, the intent sweep | `feature/operations/skeleton` |
| `soc-web` skeleton: tokens, sign-in, organization first, the persistent scene, panels, runtime configuration | `feature/web/shell` |
| Compose stack for the mini-PC, the stack check in CI, the deploy command with its flight guard | `feature/infra/stack-and-check` |
| Viability session on the mini-PC, measured | `feature/infra/viability-session` |

**Exit criteria**

- [ ] Broadcast on a private channel delivers samples from `soc-cloud` to a member's browser on the mini-PC with p95 ≤ 150 ms, refuses a non-member, and still does after the Realtime container is recreated; the tenant's limits and every policy on `realtime.messages` read and recorded (`DEP-23`, `DEP-25`, `RISK-07`)
- [ ] A pilot's command reaches `soc-cloud` through `pg_notify` within 50 ms at p95, and a command committed while `soc-cloud` was down runs once when it returns, or expires (ADR-0006)
- [ ] `soc-cloud` answers `flighttask_resource_get` within 500 ms at p99 against SO v0.4.0 with its fake bridge, and SO's dock downloads the file from `soc-cloud` (`FR-LNK-04`, `FR-LNK-05`)
- [ ] A VO2 user signs in to SOC and sees only their organizations (`FR-AUT-01`, `FR-AUT-02`)
- [ ] The scene renders nothing while idle and stays within 20 ms per frame at p95 on the operator's laptop (`NFR-RES-01`, `NFR-PERF-06`)
- [ ] Every container healthy within 60 s, within its declared limits (`FR-DEP-01`, `NFR-RES-05`)
- [ ] Migrations apply twice with no change the second time; row-level security tested per role (`FR-DEP-02`, `NFR-SEC-01`)

---

## M2 — Live fleet · v0.3.0

| Step | Pull request |
| --- | --- |
| Aircraft catalogue: the sourced JSON, its schema and its loading migration | `feature/contracts/aircraft-catalogue` |
| Fleets, devices and stacks in the database, with their policies and RPCs | `feature/database/fleets` |
| Live telemetry: Broadcast fan-out, presence, stack status, latency instruments | `feature/cloud/live-telemetry` |
| Fleet panels: catalogue, devices seen, registration, detail, retirement | `feature/web/fleet-panels` |
| Aircraft in the scene: model, stalk, labels, selection, pin and follow, fly-to | `feature/web/aircraft-in-the-scene` |
| Site model: the baking tool, stylised terrain, contours, markers | `feature/infra/site-model` |

**Exit criteria**

- [ ] A device announced by SO appears within 2 s and is registered as a fleet (`FR-FLE-02`, `FR-FLE-03`)
- [ ] The fleet's telemetry moves its aircraft in the scene, p95 ≤ 150 ms from `soc-cloud` to the browser (`FR-TEL-01`, `NFR-PERF-01`)
- [ ] A frozen feed turns stale within 100 ms of the threshold; nothing is drawn past the last sample (`FR-TEL-02`)
- [ ] A pinned fleet at 15 m/s stays in the central fifth of the view (`FR-SCN-05`)
- [ ] The farm's site model is baked from its sources, reproducibly, within 8 MB (`FR-DEP-05`, `NFR-PERF-05`)

---

## M3 — Mission design · v0.4.0

| Step | Pull request |
| --- | --- |
| Geometry golden vectors and the design schema; Python predicates passing them | `feature/libs/geometry` |
| The TypeScript geometry engine: projection, predicates, circle, grid, hull and margin, bake | `feature/web/geometry-engine` |
| Geofences and waylines in the database | `feature/database/geofences-and-waylines` |
| Geofence editor and generation from waylines | `feature/web/geofence-editor` |
| Wayline designer: takeoff, points, route, circle, grid, bake, validation | `feature/web/wayline-designer` |
| Flight file builder: the WPML profile, deterministic KMZ, golden files, SO's verdict | `feature/operations/flight-files` |

**Exit criteria**

- [ ] The golden vectors pass in TypeScript and in Python (`FR-WAY-07`, `NFR-MNT-05`)
- [ ] A geofence generated with a 5 m margin keeps every waypoint and leg at least 5 m inside (`FR-GEO-03`)
- [ ] The reference waylines bake identically every time and build byte-identical files (`FR-WAY-07`, `FR-WAY-11`)
- [ ] SO accepts every reference file, and refuses each invalid fixture for the reason SOC predicted (`NFR-COMP-02`, `FR-WAY-08`)

---

## M4 — Operations · v0.5.0

Needs Sky Orchestrator's M4 items `DEP-01` to `DEP-06`, listed in the
dependency register of the requirements.

| Step | Pull request |
| --- | --- |
| Operations, flights, files, commands, events and telemetry history in the database | `feature/database/operations` |
| `soc-operations`: the lifecycle, the checks, the simulated pass, launch and completion | `feature/operations/lifecycle` |
| `soc-cloud`: commands on the wire, progress, the cloud geofence, telemetry history | `feature/cloud/flights` |
| Operation wizard and preparation console | `feature/web/operation-preparation` |
| Flight console: telemetry, commands, mode banner, track, live log | `feature/web/flight-console` |
| End-to-end suite against SO's images and fake bridge in CI | `feature/infra/end-to-end` |

**Exit criteria**

- [ ] From the web, against SO's fake bridge: prepare, simulate, turn SO to real, launch, pause, resume, finish, with every transition in the log (`FR-OPS-*`, `FR-CMD-*`, `FR-LOG-*`)
- [ ] Command latency p95 ≤ 300 ms to the wire, ≤ 1 s to the reply shown, over 100 cycles (`NFR-PERF-02`)
- [ ] A replayed track crossing the geofence returns the aircraft home within 100 ms of the sample (`FR-SAF-01`, `NFR-PERF-04`)
- [ ] A restart of either service mid-flight loses nothing and sends nothing twice (`NFR-REL-01`)
- [ ] A real prepare without a successful simulation of the same file is impossible, in SOC and in SO (`NFR-SAF-05`)

---

## M5 — First real flight · v0.6.0 · MVP

| Step | Pull request |
| --- | --- |
| The field session runbook | `feature/repo/first-flight-runbook` |
| Session one: the phone in DJI's simulator through SO, commanded from SOC | `feature/repo/simulator-session` |
| Session two: the real aircraft, the operator on the controller | `feature/repo/first-real-flight` |
| Fixes found in the sessions, each with its regression test | `bugfix/<scope>/<slug>` |

**Exit criteria**

- [ ] The simulated pass and the real flight of the same file, commanded from SOC, with the operator on the controller and ready to take over
- [ ] Telemetry in the scene throughout, budgets met with the phone (`NFR-PERF-01`)
- [ ] Pause, resume and return home sent from SOC executed by the aircraft (`FR-CMD-02`, `FR-CMD-03`)
- [ ] The operation's log and the flight's track recorded and readable after landing (`FR-LOG-01`, `FR-TEL-04`)

---

## After the MVP, scheduled rather than vague

| Milestone | Scope | Requirements |
| --- | --- | --- |
| M6 Records | Operation reports, replay, flight hours, operator history, incidents | `FR-REP-01`, `FR-REP-02`, `FR-FLE-06`, `FR-OPS-11`, `FR-FLE-07` |
| M7 Scale | Several assignments per operation, several stacks, resume after a return home, waypoint actions | `FR-OPS-12`, `FR-CMD-08`, `FR-WAY-12` |
| M8 Reach | Remote following through the tunnel, notifications, Spanish airspace zones (ENAIRE) as a layer | New decision records first |
