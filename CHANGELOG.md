# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html), for the
whole repository
([ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md)).

Each version's entries are written by hand at release time, from the pull
requests it merged.

## [Unreleased]

## [0.5.2] — 2026-10-17

The mini-PC deploys SOC on every release, as it deploys Virtual Origen and,
from its v0.5.0, Sky Orchestrator: a runner of SOC's own on the box runs the
release's deploy job, behind a switch, with no registry credential left on the
mini-PC.

### Added

- The `deploy` job in `release.yml`, on the mini-PC's runner
  (`[self-hosted, minipc]`, ADR-0026):
  - it deploys each release once its images are published;
  - a dispatch with a tag deploys that tag;
  - it runs only while `SOC_MINIPC_DEPLOY_ENABLED` is `true`;
  - it checks the stack's files, their owner and their modes, then the
    configuration with the tag's `soc-config`;
  - its token reads packages only and is signed out at the end (#143).
- `infra/deploy/set_env.py`: sets one value of an env file from stdin, so a
  secret is never on a command line or a screen (#143).
- `infra/compose/*.json.example`: the three configuration examples, held
  equal to `soc-config example` (#143).
- RISK-17: the runner while the repository is public (#143).

### Changed

- `deploy.py` deploys the first install too: before SOC's first migration
  there is no `soc.flights`, so no flight is unfinished (#143).
- The runbook's Phase 2 sets up `soc-runner`, the stack folder
  `/srv/sky-orchestrator-client/stack` and the runner, and deploys by
  dispatch. PostgREST serves `soc` after the first deploy (#143).
- The runbook's Phase 1 deploys Sky Orchestrator v0.5.0 by its own release:
  `so-runner`, its stack folder, its runner and a dispatch, reviewed by its
  session (#144).
- The runbook folds in Virtual Origen's second review: its compose is run from
  its own directory as `vo-runner`, the clone token is kept, and the runner check
  no longer matches its own shell (#139, #140, #141, #142).

### Deploy

- No migration since 0.5.0: the ledger still holds 10.
- On the mini-PC, follow `docs/mini-pc-deployment.md` with this tag and Sky
  Orchestrator v0.5.0. Phase 2 ends with the first deploy, a dispatch of
  `release.yml` with `tag=v0.5.2`. Later versions deploy themselves.

### Known limitations

- Virtual Origen does not take the shared migration lock yet: until it does,
  never migrate while a Virtual Origen release runs (the runbook's step 2.7).
- The repository is public for now (RISK-17): approve no workflow run from a
  fork.
- Broadcast latency on the box (`DEP-23`) is measured by the runbook's step
  3.3, not yet run there.
- Nothing backs up the mini-PC's database on its own yet (`RISK-08`).

## [0.5.1] — 2026-10-17

The release the mini-PC runs, beside Virtual Origen and Sky Orchestrator
v0.4.4: the joint runbook, a migration lock shared with Virtual Origen, a
deploy command that waits for flights to end, and the Broadcast measurement
the box still owes M1.

### Added

- `docs/mini-pc-deployment.md`: Virtual Origen, Sky Orchestrator and SOC
  deployed together on the mini-PC, phase by phase, reviewed by both projects
  (#133, #134).
- `infra/deploy/deploy.py <version>`: pulls a version, migrates and starts it,
  and refuses while a flight is unfinished, read again before migrating and
  before starting (`FR-DEP-06`, #135).
- `soc-broadcast-probe` in soc-cloud's image: Broadcast latency from soc-cloud
  to a member's socket through Kong, a non-member refused before and after the
  run, the member joined again across a Realtime restart (`DEP-23`, #136).

### Changed

- `soc-migrate` holds the mini-PC's shared lock (`minipc-schema-migrations`)
  for its whole run, so it never migrates while Virtual Origen does (#132).
- Sky Orchestrator v0.4.4 vendored: a flight's waypoint index never goes back
  within an execution and holds the last waypoint through the return home. The
  end to end holds it over the whole execution (#134).

### Deploy

- No migration since 0.5.0: the ledger still holds 10.
- On the mini-PC, follow `docs/mini-pc-deployment.md` with this tag. Later
  versions go through `infra/deploy/deploy.py`.

### Known limitations

- Virtual Origen does not take the shared migration lock yet: until it does,
  never migrate while a Virtual Origen release runs (the runbook's step 2.6).
- Broadcast latency on the box (`DEP-23`) is measured by the probe in the
  runbook's step 3.3, not yet run there.
- Sky Orchestrator v0.4.4 is not cleared for real flight until its build passes
  the phone's own simulator session (its NFR-SAF-04).
- Nothing backs up the mini-PC's database on its own yet (`RISK-08`).

## [0.5.0] — 2026-10-16

M4 (operations) closed: an operation is planned, prepared, simulated and flown
from the console against Sky Orchestrator's released stack, with every move in
its log, the commands held to confirm, the safety controls on every screen and
the cloud geofence watching every executing flight. Its five exit criteria are
met against Sky Orchestrator v0.4.3 and its fake bridge.

### Added

- `soc-geo`: one telemetry sample judged against a flight's geofence snapshot:
  inside, in the warning band, outside or above the ceiling, or unknown (#112).
- Migration `0010`: operations and their lifecycle of 14 states, assignments,
  operators, flight files, flights and their states, command intents,
  transition requests, the preflight checks and the append-only operation log,
  each broadcast on the organization's state topic (#115).
- `soc-cloud`:
  - each stack's status and envelope read from Sky Orchestrator's wayline API,
    an unanswered read recorded as unknown; flight files judged in dry runs
    (#114, #117);
  - a flight task's progress decoded with how it ended (#113);
  - each flight watched from its prepare: its file kept for the dock, every
    sample judged against its geofence, the first outside returning the aircraft
    home before anything is written, once, across restarts; take-off, landing,
    the aircraft's own return and stale telemetry logged; one sample a second
    kept as its track (#119).
- `soc-operations`: the lifecycle decided from each request, command outcome
  and flight progress; the sixteen preflight checks judged every second; a real
  launch only for a file whose simulation ended ok under the same phone
  configuration, in real mode (#118).
- The console:
  - the operations panel, and the operation in the inspector: its definition,
    planned flight, operators, checks, moves and log, streamed as recorded
    (#116, #120);
  - the flight console under a flying operation's header: the mode, Simulated
    flight or Real flight; the status, waypoint and progress; Pause, Resume,
    Return home, Stop and Undo, each held 1.5 s to send; the aircraft's live
    values; the commands' feed with the meaning of every refusal (#122);
  - Pause all and Return all home on every screen while an operation launches or
    flies, each region of the console failing alone (#122);
  - each flight's track drawn over its plan (#122);
  - `pnpm demo` plays the lifecycle, and the operation's aircraft flies its
    stored flight (#122);
  - the operation's five steps, plan to done, with the move to the next first,
    a simulation or a launch held back while a blocking check does not pass;
    its checks counted, those passing folded away; a card per drone with its
    route and what it says now (#128);
  - with an operation selected, only its aircraft drawn and the camera framing
    it; a drone selected while its operation is underway drawn with its flight,
    and an operation's route drawn before its flight is saved (#129).
- `contracts/results`: what each Sky Orchestrator refusal means, by the method
  that drew it, shared by soc-operations and the console (#118, #122).
- The end to end against Sky Orchestrator's released stack (`soc_e2e.so_stack`):
  its compose files and configuration contract vendored at v0.4.3, an operation
  simulated and flown real, restarts mid-flight, and its own simulation gate;
  the same flight worked in Chrome through the console (#121, #126).

### Changed

- The configuration contract is 2.3.0: soc-cloud reads `stack_status_poll_ms`
  and `stack_envelope_poll_s` (#117); soc-operations reads
  `stack_envelope_poll_s` and holds an envelope current for two of its reads;
  a status must be read more often than it goes stale (#123).
- An assignment's speed may be left blank: it is saved as the stack's limit, or
  the model's maximum where that is lower. An operation needs a geofence, and
  its height reads Height. Settings is gone from the rail, as nothing fills it
  in the MVP (#128).

### Fixed

- PF-ENVELOPE no longer fails between two reads of the envelope (#123).
- The console keeps a check or a log entry a read in flight would have
  overwritten, and reads its state again once Realtime delivers after a join,
  so a change made just after it opens is not lost (#124).
- The end to end against Sky Orchestrator no longer leaves a directory owned
  by root in the checkout: the recorded flight its compose file mounts is
  vendored (#127).
- The console no longer scrolls as a whole when something in a panel asks to be
  seen; the demo shows an operation's latest request, not its first (#128).

### Measured

- Commands through Sky Orchestrator's released stack and fake bridge, 100
  pauses and resumes of a simulated flight: 4.1 ms p95 to the wire, 21.8 ms p95
  to the dock's reply (`NFR-PERF-02` asks 300 ms and 1 s); in Chrome, 100
  commands in 50 cycles, the reply shown 99 to 114 ms p95 after the hold
  confirmed it; each logged move shown in the console within 32 ms of being
  recorded while the channel delivers (`FR-LOG-03` asks 1 s).
- The geofence return: 0.1 ms p99 over 200 replayed crossings in soc-cloud,
  2.1 ms p99 over 20 crossings through Mosquitto (`NFR-PERF-04` asks 100 ms).
- A restart of soc-cloud or soc-operations mid-flight, simulated or real: the
  flight ends ok, its prepare and execute sent once each, its track kept
  (`NFR-REL-01`).
- A real prepare of a file never simulated is refused by SOC and, sent straight
  to Sky Orchestrator, by its own gate (`314010`, `NFR-SAF-05`).

### Deploy

- Every `soc-cloud.json` needs `stack_status_poll_ms` and
  `stack_envelope_poll_s`; every `soc-operations.json` needs
  `stack_envelope_poll_s`, the same value as its soc-cloud's (default 30).
- Migration `0010` runs before the services start.

### Known limitations

- Sky Orchestrator v0.4.3 is not cleared for real flight until its build passes
  the phone's own simulator session (its NFR-SAF-04).
- The real launch is flown against the fake bridge; the first real flight is M5.
- Realtime delivers to a console's state channel only a moment after it joins;
  a change made in that moment shows once the console reads its state again,
  at most 5 s later (`JOIN_SETTLE_MS`).
- At Sky Orchestrator v0.4.3 a flight's waypoint index reads 0 after its last
  waypoint, during the return home; SO fixed it for its next release (SO #135).

## [0.4.0] — 2026-10-12

M3 (mission design) closed: geofences and waylines drawn on the farm's terrain,
baked, validated, and turned into flight files that Sky Orchestrator's own ingest
accepts, and refuses for exactly the reasons SOC predicts. Its four exit criteria
are met.

### Added

- `soc-geo`: the plane's predicates decided exactly, Sky Orchestrator's metric
  and envelope as it checks them, and the validators that hold every vector the
  console generates; the design schema, positions in GeoJSON order (#92, #94).
- The console's geometry engine, the only generator (ADR-0009): the local
  frame's inverse, exact orientation, the circle and grid tools, the geofence
  grown round the waylines by its margin, and the bake, ordered exactly up to 13
  units, each held to golden vectors that Python checks again (#94).
- Geofences and waylines in the database, with their checks, policies and
  broadcasts (migration `0008`), and the console's data for them, every
  position converted in one place (#95, #97).
- `soc-operations`: a wayline's flight file, deterministic on any machine,
  within Sky Orchestrator's WPML subset, refused for a bake with any violation,
  held to golden texts and hashes (#96).
- `soc_operations.so_acceptance`: every golden flight file run through Sky
  Orchestrator's own ingest from its checkout, compared rule by rule and
  waypoint by waypoint with SOC's prediction (#98).
- The console:
  - the geofence editor: drawn on the terrain vertex by vertex, dragged, bent,
    undone, its area and perimeter live, crossing edges in the danger colour;
    generated round the chosen waylines by a margin previewed live; listed,
    duplicated and retired (#99);
  - a design and its bake read and written exactly as the schema says (#100);
  - the wayline designer: takeoff, route, points, circle and grid on the
    terrain, previewed live; baked on every change, the path flown at its
    heights; every violation named by its rule and waypoint, the geofence's
    included; saved only clean, its design and bake together (#101);
  - `pnpm demo` answers geofences and waylines, with a seeded wayline.

### Changed

- The scene's overlays (labels, handles) stay under the panels, and a tall
  panel scrolls inside itself with the map tools in view (#99, #101).

### Fixed

- A drag on a geofence's handle no longer orbits the camera, and a click on a
  vertex no longer places another (#99).

### Measured

- Sky Orchestrator's ingest (SO `5172e08`, v0.4.2) on both reference flight
  files: `VALID` under a permissive envelope; under its defaults and a tight one,
  45 refusals, every one the rule and waypoint SOC predicted (`NFR-COMP-02`).
- The golden designs bake identically in TypeScript, and the Python validator
  finds exactly their violations (`FR-WAY-07`, `NFR-MNT-05`); every golden
  geofence grown by its margin keeps every point and leg at the margin or more
  (`FR-GEO-03`).
- The console's first load: 232.7 KB of JavaScript gzip (budget 250); the plans'
  panels load when first opened.

### Known limitations

- The stack's envelope reaches the console with the operations (FR-LNK-09, M4):
  until then the designer splits no leg and checks none of the stack's limits,
  and a geofence's ceiling is held to being above zero. The operation's
  preflight checks them before any flight.
- Sky Orchestrator's HTTP dry run (`POST /v1/validations`) joins the end-to-end
  suite with the stack session; the acceptance above runs the same ingest
  in-process.

## [0.3.1] — 2026-10-12

M2's remaining requirements, and the console reworked after Sergio's review of
the demo. Every M2 requirement that can be met without the mini-PC or Sky
Orchestrator's own images is now met and traced.

### Added

- The console:
  - a selection is followed: the camera flies in and moves with the aircraft;
    orbit and zoom turn round it and keep it, a pan or the overview lets go;
    the inspector shows only for a selection, closed by × or Escape (#88);
  - each aircraft in its own colour, the same in the scene, its label, the fleet
    panel, the inspector and the search, with a chevron and a ground wedge
    pointing its heading (#88);
  - one aircraft list, the fleets first, Register and Edit on the row; the
    inspector with its header and actions on top, the live values as tiles,
    the rest folded (#88);
  - the search in the top bar on `/`: fleets and aircraft by name, model or
    serial, accents and case aside; choosing one selects and follows it (#88);
  - the link: Reconnecting beside the clock while the live topics are cut off,
    every presence unknown meanwhile, the socket back at once when the network
    is, and everything shown fetched again (#89);
  - `?stats` shows what the scene holds on the GPU, in bytes (#90).
- `pnpm measure:memory`: the console held open on live telemetry for 70
  minutes, the heap read each minute after a collection; `pnpm measure` reads
  the GPU's share too (#90).
- `contracts/recordings`: telemetry streams as received, replayed through the
  console's store and scene and through soc-cloud's fan-out, the first a dock's
  flight with a silence and a 10 s cut; the console end to end records one with
  `SOC_E2E_RECORD` (#90).
- Tests that search the telemetry mapping, in soc-cloud and in the console, for
  any way to fill a missing value (`FR-SAF-03`, #89).

### Changed

- A sample's age counts from when it was due, so one held up by a cut reads as
  old as it is when it arrives; stale, the inspector calls its values last known
  and greys them; samples a stale threshold apart are drawn where they are, not
  glided across the gap (#89).
- No on-screen hint sentences; the live tiles in two columns (#88).
- The bug template makes showing an aircraft online, a position current or a
  check passed when it is not severity 1 (#89).

### Fixed

- The theme follows the system's until the user chooses one; the map tools stay
  bottom right whether or not a panel is open; the demo lists both aircraft its
  replay flies (#87).
- The inspector's age no longer lags a tick behind a new sample (#89).
- A test that tipped from 5 s to 4 s on one millisecond of clock now has half a
  second's margin (#90).

### Measured

- The browser's network cut for 10 s in Chrome, while the fleet was renamed:
  nothing reached the page, Reconnecting at once; back, the link in 1,006 to
  1,078 ms, a live aircraft in 1,164 to 1,168 ms, the new name in 30 to 31 ms
  (`NFR-REL-07`, 10 s).
- The JavaScript heap after 70 minutes of two aircraft at 5 Hz over the baked
  terrain: 9.7 MB, its trend 3.5 % an hour from minute 10 (`NFR-RES-02`, 150 MB
  and 5 %); what the scene holds on the GPU: 25.1 MB (`NFR-RES-03`, 256 MB).
- The frame time along the scripted 60 s path with the reworked inspector:
  17.2 ms at p95 over the terrain and over the flat ground (`NFR-PERF-06`, 20 ms).

### Known limitations

- Against Sky Orchestrator's own images: a dock speaking its contract stands in
  until SOC can read its packages on GHCR.
- On the mini-PC: nothing is measured on the box yet (`DEP-21`).
- A ridge between the camera and its target can hide the target; the camera
  stays above the ground.

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
