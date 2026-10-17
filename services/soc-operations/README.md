# soc-operations

SOC's operations
([ADR-0002](../../docs/architecture/decisions/0002-monorepo-and-service-boundaries.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)): the
operation lifecycle and its state machine, the preflight checks, the simulation
gate, and the flight files `soc-cloud` serves.

## What runs today

| Part | Module |
| --- | --- |
| Settings: the contract's keys for `soc-operations` as a typed view, from the environment; fail closed | `settings.py` |
| The executor: what the database announces, applied one job at a time, and the sweep on each connection (ADR-0006, ADR-0025) | `runner.py` |
| The lifecycle's decisions, a snapshot in and actions out, pure (FR-OPS-02 to FR-OPS-10, FR-CMD-03, FR-CMD-04) | `lifecycle.py` |
| An operation's snapshot read and a decision applied, in one transaction | `store.py` |
| What an operation must hold before it is planned and before it is prepared (FR-OPS-03, FR-WAY-08) | `validation.py` |
| The sixteen preflight checks, pure, and their inputs from the store (FR-OPS-04, FR-OPS-05, FR-OPS-08) | `checks.py`, `judging.py` |
| What the operator is told of a refusal, by the method that drew it (`contracts/results/`, FR-OPS-09) | `results.py` |
| A flight's file: built, fingerprinted and read back (FR-WAY-11) | `flight_files.py` |
| The check of those files against Sky Orchestrator's own ingest (NFR-COMP-02) | `so_acceptance.py` |
| `/health` and `/ready` on `SOC_HEALTH_PORT` (`NFR-OBS-02`), through `soc-supervision` | `service.py` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |
| The fixtures the tests share: the golden route, its flight and a stack's envelope | `testing.py` |

## What it does not do yet

| Not yet | Arrives with |
| --- | --- |
| The console: creating, planning and flying an operation, its controls, and its log | the console (M4) |
| The flight end to end, against Sky Orchestrator's fake bridge stack | M4 |

`soc-cloud` writes what the checks read (the stack's status and envelope with
their read times, each aircraft's latest sample), asks Sky Orchestrator's dry runs,
and records each flight's progress, take-off and landing from the wire.

## The lifecycle

An operation moves only along the moves of `contracts/operations/lifecycle.json`.
The database enforces that: `soc.move_operation` refuses any other move, and logs
each move in the same transaction (FR-OPS-02, IR-OPS-01). `soc-operations` decides
what each move should be from what the database announces (ADR-0006); a move it
asks outside those moves is refused and fails its job (see Failure modes).

| Request | From | Who | What happens |
| --- | --- | --- | --- |
| `plan` | `draft` | an editor or owner | The definition validated (FR-OPS-03): height, geofence, assignment, speed, pilot, and the console's flight of the wayline held to everything it must be |
| `prepare` | `planned` | an editor or owner | Validated again; the flight file built from the stored flight and kept as built (IR-FIL-01); a dry run recorded as `pending` for `soc-cloud` to ask Sky Orchestrator |
| `unprepare` | `preparing` | an editor or owner | Back to `planned` |
| `simulate` | `preparing` | a pilot who is an editor or owner | Every blocking check passing and the stack in simulator mode (FR-OPS-06): the file prepared with `simulate_mission.is_enable` 1, then executed |
| `launch` | `simulated` | a pilot who is an editor or owner | The stack in simulator mode, every blocking check passing, a simulation of this file completed (FR-OPS-13): the file prepared again in the simulator, then executed, and the flight commanded as a real one; on the ground the operation is `simulated` again, its record neither started nor closed |
| `launch` | `ready` | a pilot who is an editor or owner | The simulation of this very file ended `ok`, real mode, the same phone configuration (FR-OPS-07): the same file prepared for real, then executed (FR-OPS-09) |
| `stop` | `in_flight`, `paused` | a pilot who is an editor or owner | `return_home` to every flight not ended; the operation ends `aborted` once they have landed (FR-CMD-04) |
| `cancel` | `draft`, `planned`, `preparing`, `simulated`, `ready` | an editor or owner | `cancelled` |

**The flight.** The console is the only generator (ADR-0009): it flies the
wayline for the operation and stores the flight on the assignment.
`soc-operations` never makes geometry; it holds that flight to the wayline's
bake, the operation's figures, the stack's envelope and the geofence
(`validation.py`) and builds the file from it.

**The prepare.** An immediate waypoint task; the file's URL on the stack's
network (`soc.stacks.flight_files_url`, ADR-0008); the return altitude from the
operation's height, at least DJI's 20 m; out of control, go home; link loss left
to the device's own policy (FR-SAF-06), as Sky Orchestrator's reference flight
does.

## Hearing and working: the runner

One database connection, one worker that applies one job at a time, so no two
decisions race over an operation, and a tick every second (`TICK_S`). Judging is
coalesced: an operation already waiting to be judged is queued once.

| Heard on | What it does |
| --- | --- |
| `soc_transition_requests` | Claims the request once, decides it in a second transaction, records `accepted` or `refused` with every reason named; a decision that raises ends the request `failed` with the error |
| `soc_command_outcomes` | A prepare accepted is executed. An execute accepted while `launching` moves the operation to `in_flight`; while `simulating` it is only recorded. A refused prepare or execute ends its flight `cancelled` and moves the operation back, to `preparing` from a simulation, to `simulated` from a launch in the simulator and to `ready` from a real launch, with the meaning as the move's cause. An execute refused is undone first. `319999` on an execute changes nothing until the flight's progress settles it (DEP-27) |
| `soc_flight_progress` | A simulation that ends `ok` makes the operation `simulated`; any other end sends it back to `preparing` with its reason. A launch moves it to `in_flight`, to `paused` and back, to `returning` when its task ends; once the aircraft stands on the ground a real flight closes it, and a launch in the simulator makes it `simulated` again |
| `soc_aircraft_samples`, `soc_stack_views`, `soc_dry_run_results` | The checks of the operations they concern are judged again. A `simulated` operation becomes `ready` while every condition holds; a `ready` one goes back to `simulated` when one does not |
| Every second (`TICK_S`, 1.0 s) | The checks of every operation that is `preparing`, `simulated` or `ready` are judged again, so a value growing old turns its check unknown, or fails it for PF-FRESH and PF-ENVELOPE (FR-SAF-02) |

Not heard: `soc_command_intents` (`soc-cloud` sends those) and `soc_dry_runs`
(`soc-cloud` asks the dry run).

On every connection, the first and each reconnection, the runner sweeps:

| Found | What it does |
| --- | --- |
| A request left `running` by a crash | Ended `failed` with "soc-operations stopped while deciding it"; what its decision had written was rolled back with it |
| Every `pending` request, in arrival order | Queued to be decided; one older than `command_intent_ttl_s` expires when it is claimed |
| Every active operation | Judged again |

A job that raises is logged as `job_failed` with the job, and the worker takes the
next one. A judgement that raises is judged again by the next tick.

## The checks

`judge` returns the sixteen checks of FR-OPS-05 in their table's order, each with
its measured value and a detail sentence. `PF-CLOCK` is the only check that does not
block. A check passes only when every input it reads is present and of the kind its
contract gives, and any sample or status it reads is current (within
`telemetry_stale_after_ms`). A measured fault fails a check even when another input it
needs is missing. The topology's presence and the link state carry no read time, so
PF-ONLINE does not age them; PF-LINK, which needs a current status, keeps the gate closed.

| Check | Blocks | Passes when | Fails when | Unknown when |
| --- | --- | --- | --- | --- |
| `PF-LINK` | yes | The link to the stack is connected and the stack reports its link up | The link is not connected, or the stack reports it down | The link state, or the stack's status, is not known or not current |
| `PF-ONLINE` | yes | The aircraft is online in the topology, over a connected link | It is offline, or the link is not connected | Its presence, or the link state, is not known |
| `PF-FRESH` | yes | The latest sample was recorded within `telemetry_stale_after_ms` | The sample is older than that: the one check a stale sample fails | There is no sample, or its record time is not usable |
| `PF-GNSS` | yes | Satellites reach `min_satellites` and positioning quality `min_gps_quality` | Either is under its minimum | Either is null |
| `PF-BATTERY` | yes | The battery reaches `min_battery_start_pct` | It is under it | It is null |
| `PF-GROUNDED` | yes | The flight mode is 0, 1 or 2 (idle, preparing, ready to take off) | Any other mode, or a boolean | It is null |
| `PF-INSIDE` | yes | The aircraft is inside the geofence, its ceiling and its warning band included | Outside the polygon, or above the ceiling; or the geofence is not a simple polygon, is empty, or has a ceiling not above zero | Its position or height is missing, not finite, or not current |
| `PF-TAKEOFF` | yes | Within `takeoff_tolerance_m` of the wayline's takeoff point | Beyond it, or the takeoff point is not a position | The takeoff or the position is not known |
| `PF-WAYLINE` | yes | SOC's validation of the flight finds no problem | Any problem, each named | The wayline has not been judged |
| `PF-SO-DRYRUN` | yes | Sky Orchestrator's dry run is `valid` | `rejected`: each of its problems named, with its waypoint | `pending`, `failed`, or never asked |
| `PF-ENVELOPE` | yes | Every vertex lies within the envelope's circle (exactly on it passes), and the ceiling within its `max_height_m` | A vertex beyond the circle, or a ceiling above the limit | No unknown state: an unknown envelope, or one older than twice `stack_envelope_poll_s` (one read missed), fails it (FR-OPS-08) |
| `PF-MODE` | yes | The stack's simulator mode is known | The mode is neither a boolean nor null | It is null, or the status is not current |
| `PF-SIMULATOR` | yes | The phone's simulator is on in simulator mode and off in real mode | They disagree; the detail says what to turn | Either is null |
| `PF-ARMED` | yes | The phone is armed, with at least `min_arming_left_s` left | Not armed, or under the minimum | Armed, or the seconds left, is null |
| `PF-IDLE` | yes | The stack has no unfinished flight other than this operation's | Another flight is unfinished | Not known |
| `PF-CLOCK` | no | The stack's health has no `clock_offset` warning | The warning is present | The offset or the warnings are null, or a warning has no code |

## Refusal meanings

Sky Orchestrator's non-zero result on a command is told by the method that drew it,
from `contracts/results/results.json` (`results.py`). The same code can mean
different things on a prepare and on an execute. The meaning becomes the cause of
the move back, in the operation's log; the console shows it beside the command (M4).

| Method | Code | Told as | Asserted by |
| --- | --- | --- | --- |
| prepare | `314010` | This file has not completed a simulation on this stack, lies outside the phone's own envelope, or asks a return height the aircraft did not take: the phone's record names which | `test_lifecycle.py::test_a_refused_prepare_returns_to_ready_with_its_meaning`; lane: `test_lifecycle_against_postgres.py::test_a_refused_launch_returns_to_ready_with_sky_orchestrators_meaning` |
| prepare | `314003` | Sky Orchestrator refused the file | none |
| prepare | `319015` | The stack's mode is not known yet | none |
| prepare | `319004` | The task was prepared under the other mode: cancel it and prepare again | none |
| prepare | `319016` | The stack has another task prepared: one task at a time | none |
| execute | `314010` | Arm the phone, release the aircraft held from the phone's console, or confirm real flight on the phone's screen, and retry | `test_lifecycle.py::test_a_refused_execute_is_undone_before_going_back` |
| execute | `316010`, link down | The link to the phone is down | `test_lifecycle.py::test_316010_on_an_execute_is_told_apart_by_the_stacks_status[link-down]` |
| execute | `316010`, real mode with the simulator on | Turn the phone's simulator off | `test_lifecycle.py::test_316010_on_an_execute_is_told_apart_by_the_stacks_status[simulator-on-in-real]` |
| execute | `316010`, simulator mode with the simulator off | Turn the phone's simulator on | `test_lifecycle.py::test_316010_on_an_execute_is_told_apart_by_the_stacks_status[simulator-off-in-simulator]` |
| execute | `316010`, otherwise | The aircraft is not detected | none |
| execute | `319999` | The outcome is not known yet: SOC reads the flight's progress and the stack's status | `test_lifecycle.py::test_an_execute_with_an_unknown_outcome_waits_for_the_progress` (nothing moves) |
| execute | `319015`, `319004` | As for prepare | none |
| pause | `319046` | The task cannot be paused now: it is taking off, already paused, or over | `test_results.py::test_a_refusal_is_told_by_the_method_that_drew_it` |
| recovery | `319042` | The task cannot be resumed now: it is not paused | `test_results.py::test_a_refusal_is_told_by_the_method_that_drew_it` |
| recovery | `319044` | There is no task to resume | `test_results.py::test_a_refusal_is_told_by_the_method_that_drew_it` |
| any | any other code | Sky Orchestrator refused it, with the number | none |

## Flight files

`flight_files.py` turns a flight, the baked wayline as its operation flies it
(`$defs.flight` of `contracts/geometry/design.schema.json`), into the KMZ that Sky
Orchestrator's dock downloads (FR-WAY-11,
[ADR-0008](../../docs/architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)).
`soc-cloud` serves the bytes; this module builds them, fingerprints them and reads
them back.

| Function | Does |
| --- | --- |
| `build(flight, name=...)` | The KMZ's bytes for a flight, or a `ValueError` naming what the subset cannot fly |
| `fingerprint(kmz)` | The MD5 hex digest, as Sky Orchestrator's plan records it (`fingerprint_md5`) |
| `read(kmz)` | The flight's fields back from a KMZ this module wrote; the round-trip tests use it |

**What is written.** Two files, laid out as DJI's WPML has them:

- `wpmz/template.kml`: the wayline's name, the mission config, and a folder with
  `templateType` `waypoint` and `templateId` `0`. Sky Orchestrator reads only the
  name and the template type from it.
- `wpmz/waylines.wpml`: the mission config and one folder, with a placemark per
  waypoint in flight order. This is the file that is flown.

Every element is in the subset Sky Orchestrator accepts
([`supported-subset.md`](../../contracts/sky-orchestrator/wpml/supported-subset.md)).

**Conventions**, settled once here:

- A flight's positions are `[longitude, latitude]`. A placemark's `coordinates` are
  `longitude,latitude`, with no height. `takeOffRefPoint` is `latitude,longitude,0`:
  DJI's order is translated in this module and nowhere else.
- Heights are metres above the takeoff point (`executeHeight`). The security height
  is `takeOffSecurityHeight`.
- Speeds are metres per second. `globalTransitionalSpeed` and `autoFlightSpeed`
  carry the wayline's speed. Placemark *i*'s `waypointSpeed` is the speed on the leg
  out of waypoint *i*: the next waypoint's `speed_ms` when it has one, else the
  wayline's. The transit into waypoint 0 flies at the wayline's speed.
- `finish_action` maps to DJI's finish action: `return_home` to `goHome`, `hold` to
  `noAction`, `land` to `autoLand`.
- Headings are `fixed`, and turns are `toPointAndStopWithDiscontinuityCurvature`:
  the aircraft flies straight to each waypoint and stops there.
- Numbers are Python's shortest `repr`, in plain decimal and never in scientific
  notation, so `float(text)` gives back the value exactly.

**Determinism.** The same flight and name give the same bytes. The entries are in a
fixed order with a fixed timestamp (1980-01-01 00:00:00), with fixed attributes, and
no comment and no extra fields. They are stored rather than deflated: no zlib release
can move a byte, and a flight file is a few kilobytes.

**Refused, nothing written** (`ValueError`, naming the problem): no waypoint; an
index out of order; a position that is not two finite numbers in range; a height
not in (0, 120] m; a speed not in (0, 15] m/s, the wayline's or a waypoint's; a
takeoff security height not in (0, 120] m; a finish action other than the three;
actions on a waypoint, which the file does not write until FR-WAY-12; a speed into
waypoint 0 that differs from the wayline's, which the file cannot carry; a name that
is empty or holds a character XML cannot carry; a flight with any violation (FR-WAY-08),
each named with its rule and waypoint: a flight file is only ever built from a clean
flight.

**Read back, refused:** a DOCTYPE or an entity declaration, malformed XML, and a KMZ
that does not hold the two files in order.

**Not this module's job.** The stack's envelope is not judged here: the flight's
violations, which the console stores with it, refuse the build. `soc-operations`
judges the envelope again in its planning (`validation.py`), and PF-ENVELOPE (FR-OPS-08)
judges it on every judgement.

**Sky Orchestrator's verdict** (NFR-COMP-02). `soc_operations.so_acceptance` builds
every golden case and runs so-wayline's own `ingest.validate` on it, from Sky
Orchestrator's checkout and in its own interpreter, under three envelopes: a
permissive one, Sky Orchestrator's defaults, and one tight enough to break every
rule. Each reference file must be `VALID` under the permissive one, and every
refusal must be the one `soc_geo.limits` predicts for the flight, rule by rule and
waypoint by waypoint. Nothing of Sky Orchestrator's stack is touched:

```bash
uv run --frozen python -m soc_operations.so_acceptance \
  --so-root ../sky-orchestrator --so-python <python with lxml and jsonschema-rs>
```

On 2026-10-13, against Sky Orchestrator's `develop` at `5172e08` (v0.4.2), both
reference files were `VALID`, and all four refusing cases agreed with SOC on every
(rule, waypoint) pair: 50 findings in all. The HTTP dry run (`POST /v1/validations`)
runs the same `ingest.validate`; it joins the end-to-end suite with the stack session.

**Golden files.** `contracts/flight-files/` holds two reference waylines as text:
each one's flight, the two XML files it builds, and the KMZ's SHA-256 and fingerprint.
`tests/test_flight_files.py` rebuilds each and requires the same bytes. The subset
tests read `contracts/sky-orchestrator/wpml/supported-subset.md` and hold every element
written, every required element of a parent written, and every value to the page's
own tables. How a deliberate change regenerates a golden case is in
[its README](../../contracts/flight-files/README.md).

## Running it

```bash
uv run soc-config example soc-operations > soc-operations.json   # then set served_organizations
SOC_CONFIG_FILE=soc-operations.json SOC_HEALTH_PORT=8080 SOC_DB_HOST=db SOC_DB_PORT=5432 \
  SOC_DB_NAME=postgres SOC_DB_PASSWORD_SOC_OPERATIONS=... uv run soc-operations
```

The example leaves `served_organizations` as `null`, which stops the start: list the
organizations this instance serves (NFR-SEC-03). Each variable:

| Variable | What it is |
| --- | --- |
| `SOC_CONFIG_FILE` | The JSON file `soc-config example` wrote |
| `SOC_HEALTH_PORT` | The port `/health` and `/ready` listen on |
| `SOC_DB_HOST`, `SOC_DB_PORT`, `SOC_DB_NAME` | The Postgres the service connects to, as the `soc_operations` role |
| `SOC_DB_PASSWORD_SOC_OPERATIONS` | That role's password, the same secret as `migrate.env` |

In a container, `infra/compose/soc-operations.env.example` lists the variables, and
`infra/compose/compose.yaml` runs the service with `restart: unless-stopped`.

## Tests

```bash
uv run --frozen mypy services/soc-operations
uv run --frozen pytest services/soc-operations/tests -m "not lane"   # gate
uv run --frozen pytest services/soc-operations/tests -m lane         # lane, needs Docker
```

| File | Lane | Holds |
| --- | --- | --- |
| `test_validation.py` | gate | The plan and the flight validation, from fixtures: each missing condition named, the flight held to its bake, the envelope and the geofence |
| `test_lifecycle.py` | gate | Each decision of the lifecycle, from a snapshot to its actions: the requests, the outcomes, the progress, readiness and stop |
| `test_checks.py` | gate | The sixteen checks: the baseline passes all, each check fails or is unknown on one changed input, the safety rules (a frozen feed, a stale status or envelope, the threshold); PF-CLOCK never blocks |
| `test_flight_files.py` | gate | The KMZ: read back, the same bytes every time, the subset's refusals, the golden cases and the subset's tables |
| `test_so_acceptance.py` | gate | The acceptance check itself, against a reduced Sky Orchestrator checkout: a refusal SOC did not predict, an acceptance where SOC predicts a refusal, and a checkout that does not run each fail it |
| `test_settings.py`, `test_main.py` | gate | The keys the contract gives; each removed key named at the start; no secret shown; a refused configuration exits with status 2 and one line naming every problem |
| `test_lifecycle_against_postgres.py` | lane | An operation's whole life against the database with the runner live, soc-cloud's part played through its functions: draft to completed, the moves and flight ends in the log; a refusal decided with its reasons; a refused launch back to ready with Sky Orchestrator's meaning; the real checks written and gating the simulation |
| `test_against_postgres.py` | lane | The service comes up ready on the production Postgres image as `soc_operations` |

The lane runs on `supabase/postgres:17.6.1.136`, the image `soc_database.harness`
starts; the gate deselects it with `-m "not lane"`.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting or variable | The process exits with status 2 before opening any connection, with one line naming every problem |
| Postgres unreachable, or the password refused | The database link stays down and is retried after 0.5, 1, 2, 4 and 8 s, then every 10 s; `/ready` answers 503 naming the error |
| A query in the runner's tick fails with an error other than the database being unavailable (a connection lost mid-query, a server error) | The tick ends, the runner stops, and the process exits with status 1 and a `service_failed` line; the container restarts it (`restart: unless-stopped`), and the sweep on connect resumes the work |
| An error the database link does not retry | The process exits with status 1 and a `service_failed` line |
| A job that raises (a decision, a judgement, an outcome or a progress) | `job_failed` is logged with the job; the worker takes the next one; a judgement is judged again by the next tick |
| A transition request whose decision raises (the database refuses a move, a bug) | The request ends `failed` with the error named; the decision's writes are rolled back and the operation stays as it was |
| `soc-operations` stops while deciding a request | Nothing of the decision is kept; the next sweep closes the request `failed` |
| A member asks while `soc-operations` is down | The request waits `pending`; the sweep on start decides it, or it expires when older than `command_intent_ttl_s` (the database's claim) |
| SIGTERM or SIGINT | The database link closes and the process exits with status 0 |
| A check's input missing, or older than `telemetry_stale_after_ms` (the envelope: twice `stack_envelope_poll_s`, since soc-cloud reads it only that often) | That check is unknown, never pass, and the gate it is part of stays closed; PF-FRESH fails on a stale sample, and PF-ENVELOPE fails on an unknown or stale envelope (FR-SAF-02, FR-SAF-03) |
| A stack's status or envelope that does not match its contract (a mode that is not a boolean) | Every check that reads it fails, naming the field; nothing is prepared or made ready |
| The stack's mode unknown | No prepare: `simulate` is refused naming it; `launch` is refused, the stack not being in real mode (FR-SAF-04) |
| A blocking check fails while an operation is `preparing` | `simulate` is refused naming the check, and no prepare is made (FR-OPS-06) |
| A blocking check fails while an operation is `ready` | The operation goes back to `simulated`, naming the first problem (FR-OPS-07) |
| The phone's configuration changed after the simulation | A `simulated` operation stays `simulated`; a `ready` one goes back to `simulated`; `launch` is refused naming both fingerprints (FR-OPS-07) |
| A flight that the subset cannot fly | `flight_files.build` raises `ValueError` naming it; no file is made |
| A flight with violations | `flight_files.build` refuses it, naming each rule and waypoint; no file is made |
| A flight that breaks the geofence, the envelope or the bake | Planning refuses the operation (`plan`, `prepare`), each problem named (`validation.py`) |
| A change to the builder moves a byte of a flight file | The golden tests fail; a deliberate change regenerates the golden case in the same commit |
| Sky Orchestrator's dry run rejects the file | `PF-SO-DRYRUN` fails, naming each problem and its waypoint; `simulate` is refused while it fails |
| Sky Orchestrator refuses a prepare | The flight ends `cancelled` and the operation goes back (to `preparing` from a simulation, to `ready` from a launch), with the meaning as the cause of the move |
| Sky Orchestrator refuses an execute | The task is undone first; then the flight ends `cancelled` and the operation goes back as for a prepare |
| Sky Orchestrator's execute outcome is unknown (`319999`) | Nothing moves until the flight's progress settles it (DEP-27) |
| A flight's progress ends while its operation is still `launching` | The database refuses the move from `launching` to `returning`, which the lifecycle does not list; the job is logged `job_failed`, nothing is moved, the flight stays unended, and the operation stays `launching` |
| A pilot's stop | Every flight not ended is sent `return_home`; the operation goes to `returning` and ends `aborted` with `operator_stop` once they have landed |
