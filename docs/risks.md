# Risk register

Ordered by expected damage, not by likelihood. Every risk names a **trigger**:
the observation that says the risk is materialising, not a guess about whether it
will.

Severity: `S1` can contribute to losing an aircraft or hurting someone. `S2`
blocks the project or damages a neighbouring one. `S3` costs time.

---

## RISK-01 · S1 · A stale or wrong position shown as live

**What**: the console shows an aircraft where it was, not where it is, and the
operator decides on it.

**Likelihood**: Medium. Telemetry crosses SO, the broker, `soc-cloud`, Realtime
and the browser; any of them can stall silently.

**Mitigation**: age on every value and a stale state computed in the browser from
the time since the last sample arrived, which needs no clock agreement
(`FR-TEL-02`); interpolation never extrapolates past the last sample; dependent
checks turn unknown, not pass (`FR-SAF-02`); honest availability is a severity-1
rule (`NFR-SAF-02`).

**Trigger**: any frame drawing a position older than `telemetry_stale_after_ms`
without the stale treatment, found by test or in a session.

---

## RISK-02 · S1 · The cloud geofence reacts late or wrongly

**What**: at 1 Hz telemetry an aircraft can be several metres past the boundary
before SOC sees it; GPS noise near the boundary can trigger a return that was not
needed.

**Likelihood**: Medium.

**Mitigation**: SO's device envelope is the authority (`NFR-SAF-01`); generated
geofences keep at least 5 m of margin (`FR-GEO-03`); a warning band raises a
warning before any action (`FR-SAF-01`); 5 Hz telemetry is requested from SO
(`DEP-07`); reaction time measured in CI (`NFR-PERF-04`).

**Trigger**: a breach event whose distance outside exceeds the geofence's margin,
or a return home logged with no sample outside.

---

## RISK-03 · S1 · A safety command does not get through

**What**: a pilot presses pause or return home and nothing happens in time:
Realtime disconnected, Kong restarting during a Virtual Origen release, a service
down.

**Likelihood**: Low to medium.

**Mitigation**: the remote controller stays in the pilot's hands and outranks SOC
(`ASM-01`); every command shows its progress live (`FR-CMD-06`); intents survive
restarts and are swept on reconnection (`NFR-REL-01`); command latency is logged
continuously (`NFR-OBS-04`); the runbook forbids Virtual Origen releases during a
flight.

**Trigger**: any command `pending` for more than 1 s, or `timed_out`.

---

## RISK-04 · S1 · Simulated and real confused

**What**: the operator believes a flight is simulated when it is real, or a
record says simulated for a real flight.

**Likelihood**: Low, with severe consequences.

**Mitigation**: the mode comes from SO's report and is never inferred, nothing is
prepared while it is unknown (`FR-SAF-04`); a banner states the mode on every
flight screen; SO's own guard (`DEP-02`).

**Trigger**: any flight whose mode is unknown, or differs from what SO reported.

---

## RISK-05 · S1 · Two people command one aircraft

**What**: two pilots in SOC, or a pilot in SOC and the pilot on the controller,
issue conflicting commands.

**Likelihood**: Medium once several operators use SOC.

**Mitigation**: only pilots of the operation command (`FR-CMD-01`); every command
shows its author to everyone watching (`FR-CMD-06`); the controller outranks the
cloud in SO's authority ladder.

**Trigger**: two commands from different pilots on one flight within 2 s.

---

## RISK-06 · S2 · Sky Orchestrator's milestone M4 slips

**What**: SOC's M4 and M5 need SO's stack status, simulation guard, envelope and
dry run (`DEP-01` to `DEP-06`).

**Likelihood**: Medium: SO's M4 has no date.

**Mitigation**: SOC's M1 to M3 need none of them; each dependency names what it
blocks; SOC fails closed without them rather than guessing (`FR-SAF-04`).

**Trigger**: SOC's M3 closes and any of `DEP-01` to `DEP-06` is not merged in SO.

---

## RISK-07 · S2 · Realtime Broadcast does not behave as designed on the shared stack

**What**: Broadcast with private channels has never run on Virtual Origen's
Realtime; its tenant row is re-seeded when the container is recreated, possibly
dropping settings.

**Likelihood**: Medium.

**Mitigation**: measured in M1 on the mini-PC, including a recreate of the
container, before anything depends on it (`DEP-23`); fallback design: telemetry
through `postgres_changes` on a narrow table, at a higher database cost.

**Trigger**: the M1 session fails any Broadcast criterion.

---

## RISK-08 · S2 · No offsite copy of the records

**What**: the database is on the mini-PC only, with no offsite backup (Virtual
Origen's recorded debt). A disk failure loses flight records and operation logs.

**Likelihood**: Low per year, total when it happens.

**Mitigation**: SOC's records are small; an export of schema `soc` after each
operation, kept off the mini-PC, is scheduled for M6; Virtual Origen's backup,
when it exists, covers SOC too.

**Trigger**: an operation completes and its records exist in one place only.

---

## RISK-09 · S2 · SOC slows the farm

**What**: SOC shares Postgres, Realtime and the mini-PC's memory with a farm's
control loop that runs with no retries.

**Likelihood**: Medium.

**Mitigation**: resource budgets and container limits (`NFR-RES-*`), batched
history writes, no polling, no connection pools.

**Trigger**: a Virtual Origen statement timeout, or Postgres above 50 % of a core,
during a SOC session.

---

## RISK-10 · S2 · The scene is too heavy for the operator's laptop

**What**: a 3D scene that stutters during a flight hides what matters at the
worst moment.

**Likelihood**: Medium.

**Mitigation**: on-demand rendering, no post-processing, a stylised terrain of
bounded size, budgets measured in M1 on the real laptop (`NFR-PERF-06`,
`NFR-RES-*`).

**Trigger**: frame time above 20 ms at p95 on the scripted camera path.

---

## RISK-11 · S2 · Another cloud client takes SOC's connection

**What**: SO allows one `cloud-client` connection per stack. Running SO's own
tools against a stack while SOC is connected disconnects SOC.

**Likelihood**: Medium during development and field sessions.

**Mitigation**: the takeover is detected and shown as a link alarm
(`FR-LNK-01`); the runbook orders the tools.

**Trigger**: a `link_displaced` event.

---

## RISK-12 · S2 · Plain HTTP on the LAN breaks browser APIs

**What**: a LAN address over HTTP is not a secure context; some APIs do not exist
there and tests on `localhost` do not notice (Virtual Origen's ADR 0032).

**Likelihood**: High without a guard.

**Mitigation**: a lint rule and an end-to-end check from a LAN address
(`NFR-PORT-04`).

**Trigger**: any error in the LAN end-to-end check.

---

## RISK-13 · S2 · Governance and minutes on the free plan

**What**: rulesets cannot be applied to a private repository on the free plan, so
nothing server side stops a direct push or a red merge. Actions minutes are
shared with SO and VO2.

**Likelihood**: Certain for rulesets; medium for minutes.

**Mitigation**: pre-commit hooks and the pull request policy; one-job pipelines
triggered by pull requests only, the slow stages path-filtered
([CI/CD](ci-cd.md)).

**Trigger**: a commit on `main` or `develop` not made by a merge; the account's
minutes above 70 % before the twentieth of the month.

---

## RISK-14 · S3 · Site model sources change or disappear

**What**: the imagery and elevation services change their terms or endpoints.

**Likelihood**: Low.

**Mitigation**: the baked site is kept with its provenance and reused; a flat
fallback (`FR-SCN-02`); global sources as alternatives.

**Trigger**: a bake fails or a source's licence changes.

---

## RISK-15 · S2 · Flights outside the rules

**What**: SOC does not check airspace, registration or the operator's
qualifications. A flight it commands can break aviation rules.

**Likelihood**: Depends on the operator.

**Mitigation**: the operator's responsibility, stated in the README; SOC records
who commanded each flight; an airspace layer is scheduled (M8).

**Trigger**: not observable by SOC; reviewed before every field session.

---

## RISK-16 · S3 · A Virtual Origen upgrade changes the platform under SOC

**What**: a new Realtime, PostgREST or GoTrue on the mini-PC changes behaviour SOC
depends on.

**Likelihood**: Medium over a year.

**Mitigation**: the identity contract and its gate test on Virtual Origen's side
(`DEP-20`); SOC's test harness pinned to the box's versions, updated together.

**Trigger**: a Virtual Origen release changing a Supabase image.
