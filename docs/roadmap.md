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
Every milestone gets at least one release (Sergio's rule, 2026-10-11): one
whose criteria are not all demonstrated is released all the same, its open
criteria named in the changelog's Known limitations, and closes once they are.

The MVP is M5: **a first real flight commanded from SOC**
([ADR-0013](architecture/decisions/0013-narrow-vertical-slice-for-the-mvp.md)).

| Milestone | Release | Outcome | State on 2026-10-12 |
| --- | --- | --- | --- |
| M0 Foundations | v0.1.0 | Repository, conventions, pipelines, requirements, decisions | Closed, released |
| M1 Platform and viability | v0.2.0 | Every unit runs, measured where the design could break | Released with 4 of 7 criteria demonstrated; 3 wait on the mini-PC's box steps and read access to SO's packages |
| M2 Live fleet | v0.3.0, v0.3.1 | A registered aircraft's live telemetry in 3D, on the farm's terrain | Closed, released: 5 of 5 criteria, in the console end to end; v0.3.1 met the rest of its requirements the mini-PC does not wait on |
| M3 Mission design | v0.4.0 | Geofences and waylines drawn, baked, validated, turned into files SO accepts | Closed, released: 4 of 4 criteria; Sky Orchestrator's own ingest accepts every reference file and refuses as SOC predicts |
| M4 Operations | v0.5.0 | A whole operation flown from the web against SO's fake bridge | Next |
| M5 First real flight | v0.6.0 | **MVP**: the same, with the real aircraft | Planned |

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

## M1 — Platform and viability · *released 2026-10-11, v0.2.0, three criteria open*

Released by decision, one release per milestone: the open criteria need the
mini-PC and read access to Sky Orchestrator's packages, and close there.

| Step | Pull request |
| --- | --- |
| Migration runner, schema `soc` baseline, database test harness with VO2's contract surface | `feature/database/soc-baseline`, merged (#15) |
| Shared Python: the configuration contract and its loader, correlated logs | `feature/libs/config-and-logs`, merged (#18) |
| Shared Python: the one database connection, with `LISTEN`, claims and `COPY` | `feature/libs/database-connection`, merged (#19) |
| Shared Python: the Realtime Broadcast client, with its HTTP fallback, and the supervision every link shares | `feature/libs/realtime-client`, merged (#20) |
| The real Realtime in the database lane: private channel joins held to SOC's policies, the client end to end | `feature/database/realtime-lane`, merged (#21) |
| Sky Orchestrator's wire contracts vendored at a pinned commit, held to their checksums | `feature/contracts/sky-orchestrator-wire`, merged (#22) |
| `soc-cloud` skeleton: settings, the wire contract, database and Realtime links, health, the process | `feature/cloud/service-skeleton`, merged (#23) |
| `soc-cloud` stack links: one MQTT link per stack, topology and presence, OSD ingest, `status_reply` | `feature/cloud/stack-links`, merged (#24) |
| `soc-cloud` flight files: the dock's `flighttask_resource_get` answered from memory, the file server | `feature/cloud/flight-files`, merged (#25) |
| `soc-cloud` command path: command intents in the database, announced, claimed once, put on the wire | `feature/database/command-intents`, merged (#26); `feature/cloud/commands`, merged (#27) |
| Sky Orchestrator's contracts pinned to its v0.4.1 release | `feature/contracts/sky-orchestrator-v0.4.1`, merged (#28) |
| `soc-operations` skeleton: configuration, health, the database link; its transition intents arrive with the operations in M4 | `feature/operations/skeleton`, merged (#29, fixed by #30) |
| `soc-web` skeleton: tokens and the shell; sign-in, organization first and the runtime configuration; the persistent scene and panels | `feature/web/scaffold`, merged (#34); `feature/database/member-organizations`, merged (#35); `feature/web/sign-in`, merged (#38); `feature/web/image`, merged (#40); `feature/web/scene`, merged (#43) |
| Compose stack for the mini-PC, the stack check in CI, the deploy command with its flight guard | `feature/infra/images`, merged (#32): the images and the compose project; `feature/repo/release-images`, merged (#33); `feature/infra/stack-and-check`, waiting for read access to Sky Orchestrator's packages on GHCR |
| Viability session on the mini-PC, measured | `feature/infra/viability-session`, waiting for the box steps (`DEP-21`) |

**Exit criteria**

- [ ] Broadcast on a private channel delivers samples from `soc-cloud` to a member's browser on the mini-PC with p95 ≤ 150 ms, refuses a non-member, and still does after the Realtime container is recreated; the tenant's limits and every policy on `realtime.messages` read and recorded (`DEP-23`, `DEP-25`, `RISK-07`). Proven on the same Realtime and Postgres versions: on the container lane a non-member is refused, and in the console end to end a browser receives every sample within 28 ms at p95 over ten minutes; on the box in the viability session
- [x] A pilot's command reaches `soc-cloud` through `pg_notify` within 50 ms at p95, and a command committed while `soc-cloud` was down runs once when it returns, or expires (ADR-0006): both on the container lane, `services/soc-cloud/tests/test_against_platform.py`
- [ ] `soc-cloud` answers `flighttask_resource_get` within 500 ms at p99 against SO v0.4.0 with its fake bridge, and SO's dock downloads the file from `soc-cloud` (`FR-LNK-04`, `FR-LNK-05`). Against a dock speaking SO's contract: p99 under 500 ms over 100 requests and the exact bytes downloaded; against SO's own images once their packages can be read
- [x] A VO2 user signs in to SOC and sees only their organizations (`FR-AUT-01`, `FR-AUT-02`): in Chrome through GoTrue v2.189.0 behind Kong, the version VO2 runs (`infra/e2e`), and `soc.member_organizations` returns live memberships only (`database/tests/test_member_organizations.py`)
- [x] The scene renders nothing while idle and stays within 20 ms per frame at p95 on the operator's laptop (`NFR-RES-01`, `NFR-PERF-06`): 0 frames over 30 s idle; 17.6 ms at p95 along `pnpm measure`'s 60 s path with two aircraft at 1920×1080, on an Intel UHD below the Iris Xe class of `ASM-02` (2026-10-11)
- [ ] Every container healthy within 60 s, within its declared limits (`FR-DEP-01`, `NFR-RES-05`). SOC's images, each on its own: `soc-operations` healthy within 60 s under 64 MiB, `soc-web` under 16 MiB (`infra/check`); the whole stack's timed bring-up arrives with the stack check
- [x] Migrations apply twice with no change the second time; row-level security tested per role (`FR-DEP-02`, `NFR-SEC-01`): the migration image applies them once, then nothing (`infra/check`); every table's policies tested per role (`database/tests`)

---

## M2 — Live fleet · *closed 2026-10-11, v0.3.0; v0.3.1 2026-10-12*

| Step | Pull request |
| --- | --- |
| Aircraft catalogue: the sourced JSON, its schema and its loading migration | `feature/contracts/aircraft-models`, merged (#45), 38 models |
| Fleets, devices and stacks in the database, with their policies and RPCs | `feature/database/fleets`, merged (#48) |
| Live telemetry: Broadcast fan-out, presence, stack status, latency instruments | `feature/libs/stack-organization`, merged (#50); `feature/cloud/presence`, merged (#51); `feature/cloud/live-telemetry`, merged (#52); `feature/cloud/latency`, merged (#53) |
| Fleet panels: catalogue, devices seen, registration, detail, retirement | `feature/web/panels`, merged (#54, the view in the URL); `feature/web/fleet-data`, merged (#55); `feature/web/fleet-panel`, merged (#56); `feature/web/fleet-forms`, merged (#60) |
| Aircraft in the scene: model, stalk, labels, selection, pin and follow, fly-to | `feature/web/settings`, merged (#61, the console's thresholds); `feature/web/live-telemetry`, merged (#62, the browser's telemetry and the inspector's live values); `feature/web/scene-aircraft`, merged (#70); `feature/web/scene-selection`, merged (#72); `feature/web/scene-pin`, merged (#73); `feature/web/delivery-latency`, merged (#74) |
| Site model: the baking tool, stylised terrain, contours, markers | `feature/infra/site-bake`, merged (#75, the baking tool); `feature/web/site-terrain`, merged (#77); `feature/web/serve-site`, merged (#78); `feature/web/heights-over-terrain`, merged (#79); `feature/web/camera-over-terrain`, merged (#81) |
| Measured: the frame time on the production build, and the exit criteria through the console | `feature/web/measure-frames`, merged (#80, `pnpm measure`); `feature/infra/console-e2e` (#82, `infra/e2e`: the platform behind Kong, soc-cloud, a dock, the console in Chrome) |

After the close, v0.3.1 (2026-10-12): the console reworked after Sergio's review
of the demo (#87, #88: the selection followed, each aircraft's colour, the
inspector, the search), and every M2 requirement the mini-PC does not wait on met:
the browser's reconnection, honest freshness and no value ever invented (#89), the
memory over an hour, the GPU's share and recorded flights as fixtures (#90).

**Exit criteria**

- [x] A device announced by SO appears within 2 s and is registered as a fleet (`FR-FLE-02`, `FR-FLE-03`): 87 to 423 ms in Chrome, from a dock speaking SO's vendored contract, registered through the console's form (`infra/e2e`); against SO's own images in the stack session
- [x] The fleet's telemetry moves its aircraft in the scene, p95 ≤ 150 ms from `soc-cloud` to the browser (`FR-TEL-01`, `NFR-PERF-01`): from the dock's publish to the browser, 15 to 36 ms at p95 (`infra/e2e`)
- [x] A frozen feed turns stale within 100 ms of the threshold; nothing is drawn past the last sample (`FR-TEL-02`): Stale 2999 to 3001 ms after the last sample in Chrome (`infra/e2e`); the glide's 2,000-case fuzz
- [x] A pinned fleet at 15 m/s stays in the central fifth of the view (`FR-SCN-05`): the follow test over 60 s of the replay
- [x] The farm's site model is baked from its sources, reproducibly, within 8 MB (`FR-DEP-05`, `NFR-PERF-05`): `soc-site`, Finca Norte's bake 3.1 MB

---

## M3 — Mission design · *closed 2026-10-12, v0.4.0*

| Step | Pull request |
| --- | --- |
| Geometry golden vectors and the design schema; Python predicates passing them | `feature/libs/projection` (#66, the local frame and its vectors, brought forward for the scene's aircraft in M2); `feature/libs/geometry` (#92: Sky Orchestrator's metric and geodesy cases, the plane's predicates and shapely's vectors, the design schema 1.0.0) |
| The TypeScript geometry engine: projection, predicates, circle, grid, hull and margin, bake | `feature/web/geometry-engine` (#94: the inverse projection, exact predicates, Sky Orchestrator's metric and envelope, the circle and grid tools, the grown geofence and the bake, each with vectors libs/soc-geo checks) |
| Geofences and waylines in the database | `feature/database/geofences-and-waylines` (#95); the console's data, `feature/web/geofence-wayline-data` (#97) |
| Geofence editor and generation from waylines | `feature/web/geofence-editor` (#99) |
| Wayline designer: takeoff, points, route, circle, grid, bake, validation | `feature/web/design-json` (#100, the design read and written as the schema says); `feature/web/wayline-designer` (#101) |
| Flight file builder: the WPML profile, deterministic KMZ, golden files, SO's verdict | `feature/operations/flight-files` (#96); `feature/operations/so-acceptance` (#98, Sky Orchestrator's own ingest) |

**Exit criteria**

- [x] The golden vectors pass in TypeScript and in Python (`FR-WAY-07`, `NFR-MNT-05`): circle, grid, grown geofence and bake, each written by the TypeScript and checked again by `soc-geo` in the gate
- [x] A geofence generated with a 5 m margin keeps every waypoint and leg at least 5 m inside (`FR-GEO-03`): the 5 m golden case and every other margin, by the Python validator
- [x] The reference waylines bake identically every time and build byte-identical files (`FR-WAY-07`, `FR-WAY-11`): the bake vectors rewrite unchanged, and the flight files' entries are stored, so their hashes hold on any machine
- [x] SO accepts every reference file, and refuses each invalid fixture for the reason SOC predicted (`NFR-COMP-02`, `FR-WAY-08`): its own ingest, run from its checkout by `soc_operations.so_acceptance`

---

## M4 — Operations · v0.5.0

Needs Sky Orchestrator's M4 items `DEP-01` to `DEP-06`, listed in the
dependency register of the requirements.

| Step | Pull request |
| --- | --- |
| Operations, flights, files, events, telemetry history, and the operation transition requests `soc-operations` executes (ADR-0006) in the database | `feature/database/operations` |
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
| The field session runbook, with the phone's envelope compared to so-wayline's | `feature/repo/first-flight-runbook` |
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
