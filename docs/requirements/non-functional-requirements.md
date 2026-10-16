# Non-functional requirements

Categories and priorities are defined in the requirements index. Every bound
names a percentile or a threshold: a requirement nobody can fail is not a
requirement.

Measurement context unless stated otherwise: the mini-PC running Virtual
Origen's Supabase, Sky Orchestrator and SOC; a laptop on the farm's LAN running
the latest Chrome; Sky Orchestrator with its fake bridge or the phone in DJI's
simulator.

---

## Assumptions

| ID | Assumption | If it turns out false |
| --- | --- | --- |
| `ASM-01` | The operator is on site, with the aircraft in sight and the remote controller in hand. SOC never replaces the pilot. | SOC's safety model is void. Out of scope: remote operation needs its own decision record and regulatory basis. |
| `ASM-02` | The operator's laptop supports WebGL 2 with at least an integrated GPU of the Intel Iris Xe class. | The frame-rate budget (`NFR-PERF-06`) is measured on that class; weaker devices get a reduced scene. |
| `ASM-03` | The organization's position in Virtual Origen is set and lies inside the farm. | The site model and the scene centre on the wrong place; SOC refuses to bake a site for an organization without a position. |
| `ASM-04` | Elevation and imagery of the farm's area can be obtained from Spain's IGN (PNOA imagery, MDT elevation) or a global fallback, under licences that allow this use. | The scene falls back to a flat ground (`FR-SCN-02`). |
| `ASM-05` | Sky Orchestrator delivers the items SOC depends on (listed in [dependencies](dependencies.md)) in its milestone M4. | The SOC milestones that use them wait; each dependency names what is blocked. |
| `ASM-06` | The mini-PC, the laptop and the phone take their time from the network, so their clocks agree within 1 s. | Latency figures across devices are measured with a clock offset estimated by round trips, never assumed zero. |

## Constraints

| ID | Constraint |
| --- | --- |
| `CON-01` | One mini-PC, Ubuntu on x86_64, Docker Compose, shared with Virtual Origen and Sky Orchestrator. No orchestrator, no cluster. |
| `CON-02` | The database is Virtual Origen's single self-hosted Supabase (VO2's ADR 0052). SOC owns schema `soc` and nothing else in it. |
| `CON-03` | SOC reaches Sky Orchestrator only through DJI's wire and SO's documented HTTP surfaces ([ADR-0004](../architecture/decisions/0004-soc-is-the-dji-cloud-party.md)). |
| `CON-04` | One Sky Orchestrator stack per aircraft, one Cloud API connection per stack. |
| `CON-05` | Sky Orchestrator flies immediate waypoint tasks only, with heights relative to takeoff, in its WPML subset, within its configured envelope. |
| `CON-06` | The aircraft is a DJI Mavic Air 2 behind Sky Orchestrator, reported on the wire as a Matrice 3D. |
| `CON-07` | The interface, the code, the documentation and the repository are in English. |
| `CON-08` | The palette is Bootswatch Minty, shared with Virtual Origen. |
| `CON-09` | The repository is private on GitHub's free plan: Actions minutes are shared with Sky Orchestrator and Virtual Origen, and rulesets cannot be applied. |
| `CON-10` | Nothing on the path from a click to an aircraft depends on the internet ([ADR-0015](../architecture/decisions/0015-lan-first-deployment.md)). |

---

## NFR-PERF — Performance

### NFR-PERF-01 — Telemetry delivery · MUST
From `soc-cloud` receiving an aircraft OSD to a subscribed browser receiving it:
**≤ 150 ms at p95, ≤ 300 ms at p99** on the LAN.

**Measured by**: the browser's receive time against the sample's receive time in
`soc-cloud`, with the browser's clock offset estimated by round trips, over a
10 minute run at 5 Hz.

### NFR-PERF-02 — Command latency · MUST
From a pilot's confirmation to the command published on Sky Orchestrator's
`services` topic: **≤ 300 ms at p95**. From the confirmation to the reply shown in
the console: **≤ 1 s at p95**. The confirmation is the moment the command is
asked: a click, or the end of the hold that confirms a command (`FR-CMD-07`).

**Measured by**: the intent's creation, publish and reply times, over 100
command cycles against the fake bridge stack.

### NFR-PERF-03 — The dock's file request · MUST
`flighttask_resource_get` answered **≤ 500 ms at p99** (Sky Orchestrator waits
1.5 s).

**Measured by**: request and reply times on the wire, over 100 requests.

### NFR-PERF-04 — Geofence reaction · MUST
From an outside sample's arrival in `soc-cloud` to `return_home` published:
**≤ 100 ms at p99**.

**Measured by**: replayed boundary-crossing tracks in the gate and in the end to
end suite.

### NFR-PERF-05 — Loading · MUST
On the LAN with an empty cache: the application interactive within **3 s**; the
3D scene with the site model drawn within **5 s**. Initial JavaScript **≤ 250 KB
gzip** without the 3D chunk; the 3D chunk **≤ 450 KB gzip**; the site model's
assets **≤ 8 MB**.

**Measured by**: a Lighthouse run against the production build served by
`soc-web`, and the build's size report, both in CI.

### NFR-PERF-06 — Frame rate · MUST
While the camera moves with live telemetry from two aircraft: frame time
**≤ 20 ms at p95** at 1920×1080 on the `ASM-02` laptop.

**Measured by**: the scene's frame-time sampler over a scripted 60 s camera
path.

### NFR-PERF-07 — Ingest headroom · SHOULD
`soc-cloud` sustains four stacks at 10 Hz each with bounded queues and no
dropped sample.

**Measured by**: a load test against a broker, asserting queue depth returns to
zero.

---

## NFR-RES — Resource budgets

The mini-PC runs a farm's control loop, Sky Orchestrator and SOC at once. Every
megabyte SOC uses is taken from them.

### NFR-RES-01 — Idle scene renders nothing · MUST
With the camera still and no new data, the scene renders **0 frames per second**.

**Measured by**: the frame counter over 30 s of idle, in the end-to-end suite.

### NFR-RES-02 — Web memory · MUST
JavaScript heap **≤ 150 MB** after 60 minutes of live telemetry at 5 Hz from two
aircraft, with **no upward trend above 5 % per hour**.

**Measured by**: heap snapshots at 10 and 70 minutes of a scripted session.

### NFR-RES-03 — GPU memory · MUST
Textures and buffers **≤ 256 MB**, as accounted by the renderer.

**Measured by**: the renderer's memory report with the site model and the
reference operation loaded.

### NFR-RES-04 — Service footprint · MUST
Each backend service: **≤ 64 MB resident at rest**, **≤ 96 MB under the
`NFR-PERF-07` load**, **≤ 0.5 % of a core at rest**.

**Measured by**: each container's cgroup counters, as Sky Orchestrator's
footprint test reads them.

### NFR-RES-05 — Declared limits · MUST
Every SOC container declares memory and CPU limits; the stack's memory limits add
up to **≤ 512 MB**.

**Measured by**: a gate test over the compose file.

### NFR-RES-06 — Database load · MUST
Telemetry history is written at most once per `telemetry_batch_s` (default 5 s)
per aircraft, as one `COPY`. No service polls the database. Each service holds
exactly one direct connection, used to listen for intents, claim them and write
(ADR-0006), and no pool.

**Measured by**: `pg_stat_statements` and `pg_stat_activity` over a 30 minute
session.

### NFR-RES-07 — Shared Realtime · MUST
SOC's Realtime events, sends plus deliveries as the tenant counts them, stay
**under a quarter of the tenant's `max_events_per_second`**, which Virtual Origen
shares (ADR-0007).

**Measured by**: `soc-cloud`'s send counter times the subscribers it sees, logged
per minute, and Realtime's own rate-limit headers.

---

## NFR-REL — Reliability

### NFR-REL-01 — A restart loses nothing · MUST
A restart of `soc-cloud` or `soc-operations` during a flight loses no state
transition, sends no command twice and drops no pending command.

**Measured by**: a chaos test restarting each service while a flight executes
against the fake bridge stack.

### NFR-REL-02 — At most once on the wire · MUST
An intent is published at most once, whatever the redeliveries of the events that
announce it.

**Measured by**: a test delivering each intent event three times.

### NFR-REL-03 — Automatic recovery · MUST
Every container restarts on failure and reconnects to its broker and to Supabase
with backoff capped at 10 s, healthy within 30 s of its dependency returning.

**Measured by**: killing each dependency in turn in the stack check.

### NFR-REL-04 — Degradation is visible · MUST
If Sky Orchestrator, Supabase or Realtime cannot be reached, the console says so
within 5 s and the services' health reports it.

**Measured by**: the stack check, cutting each in turn.

### NFR-REL-05 — Bounded over time · SHOULD
Over 24 h idle, no service grows its resident memory by more than 10 %, and
every table has a retention bound (`IR-X-04`).

### NFR-REL-06 — Neighbour releases · MUST
A Virtual Origen release restarting Kong for about 5 s, or recreating Realtime,
is survived with no operator action.

**Measured by**: restarting Kong and Realtime during a session in the stack
check.

### NFR-REL-07 — Browser reconnection · MUST
After a lost connection the browser resubscribes and refetches what it shows, so
no gap is displayed as continuous.

**Measured by**: an end-to-end test cutting the browser's network for 10 s.

---

## NFR-SAF — Safety

### NFR-SAF-01 — The device decides · MUST
Every limit that stops an aircraft is Sky Orchestrator's, enforced on the
device. SOC's checks are defence in depth and are documented as such wherever
they appear.

### NFR-SAF-02 — Honest availability · MUST
Showing a fleet online, a position current or a check passed when it is not is a
severity-1 defect regardless of blast radius, and its fix carries a regression
test in the same commit.

### NFR-SAF-03 — Failure modes are written down · MUST
`soc-cloud`, `soc-operations` and the console's command path each carry, in their
README, the enumerated ways they can fail and what happens in each case.

### NFR-SAF-04 — One automatic action · MUST
SOC's only autonomous action on an aircraft is `return_home` on a geofence breach
(`FR-SAF-01`). Nothing else moves an aircraft without a pilot's explicit command.

**Measured by**: a test enumerating every code path that publishes on `services`.

### NFR-SAF-05 — Simulation before flight · MUST
A real flight is possible only after a simulated flight of the same file ended
`ok` (`FR-OPS-07`), checked by SOC and again by Sky Orchestrator (SO's
NFR-SAF-07).

### NFR-SAF-06 — Restrictive defaults · MUST
Shipped thresholds are conservative: battery, satellites, staleness, warning
band. A fresh installation cannot be made more permissive without a documented
change.

---

## NFR-SEC — Security

### NFR-SEC-01 — Row-level security · MUST
Every `soc` table has row-level security enabled and policies tested per role.

**Measured by**: the database suite's per-role tests (`FR-AUT-03`).

### NFR-SEC-02 — The service key stays server side · MUST
Supabase's service role key exists only in the backend containers' environment.

**Measured by**: a CI step searching the built web bundle for the key's prefix
and for the variable's name.

### NFR-SEC-03 — Served organizations, fail closed · MUST
The services act only for the organizations in their allowlist. An empty or
missing allowlist stops them at start.

**Measured by**: a start test with no allowlist, and one with an intent from an
organization outside it.

### NFR-SEC-04 — No secrets in the repository · MUST
Credentials come from the environment. A commit containing one fails the
pre-commit hook and the pipeline.

**Measured by**: gitleaks over the full history on every pull request.

### NFR-SEC-05 — Least privilege towards Sky Orchestrator · MUST
The Cloud API password and the `so-wayline` token exist only in `soc-cloud`'s
environment.

### NFR-SEC-06 — Flight file URLs · MUST
Each flight file path holds at least 128 random bits, is served only on Sky
Orchestrator's network, and stops being served `flight_file_grace_s` after its
flight ends.

### NFR-SEC-07 — Web hardening · MUST
`soc-web` sends a strict Content Security Policy (no inline script, connections
only to the configured Supabase), `frame-ancestors 'none'`, a referrer policy and
no server version.

**Measured by**: a test over nginx's configuration and a header check in the
stack check.

### NFR-SEC-08 — Pinned supply chain · MUST
Lockfiles with hashes for every package manager, images pinned by digest,
GitHub Actions pinned by major version and updated by Dependabot.

---

## NFR-COMP — Protocol compatibility

### NFR-COMP-01 — Wire fidelity · MUST
Every message SOC publishes validates against Sky Orchestrator's DJI schemas,
vendored by version (`FR-LNK-10`). Every message SOC receives is checked for the
fields it reads; a message missing one is logged and ignored, never guessed.

### NFR-COMP-02 — Files Sky Orchestrator accepts · MUST
Every flight file SOC builds is accepted by Sky Orchestrator's validator: golden
files in the gate, the dry run in the end-to-end suite.

### NFR-COMP-03 — Every result has a meaning · MUST
Every DJI result code Sky Orchestrator can return has a message in SOC's
contract, shown to the operator.

**Measured by**: a test comparing SOC's table with the codes in the vendored
contracts.

### NFR-COMP-04 — Declared compatibility · MUST
SOC states the Sky Orchestrator versions it supports, and the end-to-end suite
runs against each of them.

---

## NFR-UX — Design and usability

### NFR-UX-01 — Tokens only · MUST
Colours, radii, shadows and type come from the design tokens, built on Minty.
No colour literal outside the token file.

**Measured by**: a lint rule.

### NFR-UX-02 — Contrast · MUST
Text meets WCAG AA (4.5:1, 3:1 for large text) on its surface in both themes.
Minty's light hues are fills and accents, never body text on white.

**Measured by**: a test computing the contrast of every text token on every
surface token.

### NFR-UX-03 — One view, every action · MUST
Every action is reachable from the persistent scene and its panels, with no page
reload. The URL reflects the open panel and selection, so a view can be shared on
the LAN.

### NFR-UX-04 — Keyboard · MUST
Every panel action is reachable from the keyboard, with visible focus; the safety
controls have shortcuts (`FR-CMD-07`).

### NFR-UX-05 — Motion · MUST
Interface transitions last at most 300 ms; camera flights at most 1.2 s; all of
them honour `prefers-reduced-motion`.

### NFR-UX-06 — Viewports · MUST
Laptop and desktop from 1366×768 to 2560×1440 are first class; a tablet in
landscape can follow an operation. Phones show a notice.

### NFR-UX-07 — Units and time · MUST
Metric units with their symbol (m, m/s, %, °); times in the organization's time
zone, with UTC available on hover.

### NFR-UX-08 — Visual language · MUST
The interface follows the [design system](../design/README.md): a persistent
scene, floating cards, an inspector that follows the selection, camera flights to
what is selected, labels that attach to entities.

---

## NFR-MNT — Maintainability

### NFR-MNT-01 — One concern per directory · MUST
Each unit owns its code, tests, Dockerfile, configuration and README.

### NFR-MNT-02 — Contracts at the boundary · MUST
Units meet only through `contracts/` and the database. A contract change is a
version bump with both sides updated in one pull request.

### NFR-MNT-03 — Parallel-session safe · MUST
Two sessions working in different units do not touch the same files; when they
must, it is a contract change, called out as such.

### NFR-MNT-04 — Source only · MUST
No binaries, build output, flight records or imagery in git.

### NFR-MNT-05 — Deterministic work is code · MUST
Geometry, geodesy, unit conversion, file building, fingerprints, schema
validation, latency and rate computation are tested code, never done by hand or
by a model during operation or analysis.

### NFR-MNT-06 — Code that explains itself · MUST
Names carry intent; classes and functions have one responsibility (SOLID). A
comment exists only to say why something non-obvious must be so. Python is type
checked strictly; TypeScript runs in strict mode.

**Measured by**: the type checkers and linters in the gate.

---

## NFR-TEST — Testability

### NFR-TEST-01 — Gate tests · MUST
Per unit: deterministic, offline, no hardware, under **2 s**. They run on every
commit through pre-commit and on every pull request. A flaky gate test is fixed
or deleted the same day.

### NFR-TEST-02 — Database tests · MUST
Every migration, policy and RPC is tested against an ephemeral Postgres built
from the same image as production, with Virtual Origen's contract surface loaded.

### NFR-TEST-03 — Hardware-free end to end · MUST
The whole path, browser to aircraft and back, runs in CI against Sky
Orchestrator's published images and fake bridge (SO's NFR-TEST-07), with no
phone and no aircraft.

### NFR-TEST-04 — A test with every fix · MUST
Every bug fix carries the test that fails before it and passes after it.

### NFR-TEST-05 — Recorded flights are fixtures · MUST
A recorded telemetry stream replays as a test input, so an incident becomes a
test.

### NFR-TEST-06 — No model, no eval suite · MUST
SOC has no LLM component, so it has no eval suite. If one is ever added, it
arrives as its own service with its own evals and thresholds.

---

## NFR-OBS — Observability

### NFR-OBS-01 — Correlated logs · MUST
JSON logs. Every line carries service, level and time, and where applicable the
organization, operation, flight, command, `tid` and `bid`.

**Measured by**: a test reconstructing one command from the browser to the wire
and back from logs alone.

### NFR-OBS-02 — Health with dependencies · MUST
Every service exposes a health endpoint reporting each dependency: each stack's
broker, Supabase REST, Realtime.

### NFR-OBS-03 — A measurable outcome per change · MUST
Every pull request names the metric, log line or test that shows it worked.

### NFR-OBS-04 — Latency is always measured · MUST
`soc-cloud` logs, per minute, the p50, p95 and p99 of telemetry delivery and
command latency it can see, so `NFR-PERF-01` and `NFR-PERF-02` are observed in
operation, not only in tests.

### NFR-OBS-05 — The scene reports itself · SHOULD
A developer overlay shows frame time, frames rendered, draw calls and GPU memory.

---

## NFR-PORT — Portability and deployment

### NFR-PORT-01 — Compose on Ubuntu · MUST
The target is Docker Compose on the `CON-01` mini-PC.

### NFR-PORT-02 — Pinned everything · MUST
Node, pnpm, Python, uv, base images and every dependency are pinned and recorded,
with the choices argued in the stack decision records.

### NFR-PORT-03 — No internet on the flight path · MUST
A packet capture on the host's external interface during a mission shows no
traffic from any SOC component (`CON-10`).

### NFR-PORT-04 — No secure context needed · MUST
The web works served over plain HTTP from a LAN address (ADR-0015).

**Measured by**: a lint rule against secure-context APIs and an end-to-end check
from a LAN address.

### NFR-PORT-05 — Browsers · MUST
The latest two versions of Chrome, Edge and Firefox on desktop with WebGL 2.
Safari is best effort.

---

## Changelog

| Date | Change |
| --- | --- |
| 2026-10-07 | Initial set, MVP scope. |
