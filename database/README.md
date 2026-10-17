# Database

Schema `soc` in Virtual Origen's database
([ADR-0005](../docs/architecture/decisions/0005-one-database-shared-with-virtual-origen.md)),
its migrations and their tests.

| Path | Contents |
| --- | --- |
| `migrations/` | Ordered SQL, `NNNN-kebab-name.sql`, applied by [`infra/migrate`](../infra/migrate/README.md) |
| `fixtures/` | What the tests need of the platform SOC does not own, reproduced faithfully (below) |
| `src/soc_database/` | The test harness: an ephemeral Postgres, tenancy helpers, acting as a user; `RealtimeStack`, Postgres and Realtime v2.102.3 on a private network with its tokens |
| `tests/` | The container lane (`NFR-TEST-02`) |

## What exists

| Migration | Creates |
| --- | --- |
| `0001-soc-schema` | Schema `soc`; `soc.live_member_orgs()`, `soc.is_live_member(org)`, `soc.has_live_role(org, role)`: Virtual Origen's membership helpers, plus the organization's own `deleted_at` |
| `0002-service-roles` | `soc_cloud` and `soc_operations`: login, `NOINHERIT`, three connections each, 5 s statement and 2 s lock timeouts, no password until the runner sets one |
| `0003-realtime-authorization` | Who may join SOC's private Broadcast topics `org:<id>:soc:<stream>`: members of that live organization; restrictive guards that keep SOC's topics member-only, refuse anonymous readers and every client send, and pass any other topic through |
| `0004-command-intents` | `soc.command_intents` (`IR-CMD`): announced to `soc-cloud` with `pg_notify('soc_command_intents', id)` at commit, broadcast on `org:<id>:soc:state` on every change, forward-only (`IR-CMD-01`); `soc-cloud` claims (or expires, past `command_intent_ttl_s`), records the reply, times out, or fails one through four functions; members read their organization's, `soc-operations` requests, nobody else writes |
| `0005-member-organizations` | `soc.member_organizations()`: the caller's live memberships of live organizations, with their role, the organization's position and time zone, by name; what the web offers at sign-in (`FR-AUT-02`). Security invoker, signed-in users only |
| `0006-aircraft-models` | `soc.aircraft_models` (`IR-MOD`): the catalogue of `contracts/catalogue`, each published figure with its source; `soc.load_aircraft_models(catalogue)` upserts and never removes, run only by migrations; every signed-in user reads it, nobody writes it |
| `0007-fleets` | `soc.stacks`, `soc.devices`, `soc.fleets` (`IR-STK`, `IR-DEV`, `IR-FLE`): `soc-cloud` records each stack's link and organization, the devices it announces (online only while listed and reported online, `FR-LNK-02`) and their firmware through three functions; a fleet is registered from a device its organization's stack has seen, by an editor, once among live fleets; retiring is final and timed by the database; every change broadcast on `org:<id>:soc:state` |
| `0008-geofences-and-waylines` | `soc.geofences`, `soc.waylines` (`IR-GEO`, `IR-WAY`): editors save them, members read their organization's, `soc-cloud` and `soc-operations` read every row; a wayline's design and baked waypoints are saved together and loaded as saved (`IR-WAY-01`); a margin only when a geofence is generated; a ring's simplicity is left to the validators in code (`FR-GEO-04`); retiring is final and timed by the database; every change broadcast on `org:<id>:soc:state` |
| `0009-waylines-without-flight` | Drops `soc.waylines.speed_ms`, and `metrics` no longer requires a duration: a wayline is geometry (`IR-WAY`, `FR-WAY-09`, `FR-WAY-10`), its speed, climb, finish and duration belong to the operation (`M4`); `metrics` holds the waypoint count and the distance; the grants are stated again without the column; live waylines saved by 0.4.0 move to design schema 2.0.0 (their three operation keys leave the design, `duration_s` leaves `metrics`), retired ones are not touched |
| `0010-operations` | The operations (`IR-OPS`, `IR-ASG`, `IR-OPR`, `IR-FIL`, `IR-FLT`, `IR-FST`, `IR-EVT`, `IR-TEL`, `IR-TRQ`): the lifecycle, the append-only log, flight files, flights and their progress, telemetry, checks, dry runs and transition requests, with the functions that move and record them; see [Operations](#operations-0010) |
| `0011-launch-in-the-simulator` | A launch in the simulator (`FR-OPS-13`, ADR-0027): the moves `simulated` to `launching`, and `launching` and `returning` back to `simulated`; `started_at` set by a launch from `ready` only; what a launch in the simulator names fixed until it lands |

## Operations (0010, 0011)

`operation_moves` and `event_kinds` are written as [`lifecycle.json`](../contracts/operations/lifecycle.json) and [`events.json`](../contracts/events/events.json) list them; `test_operations.py` and `test_operation_log.py` hold each table equal to its file.

### Tables

| Table | Holds |
| --- | --- |
| `operation_moves` | The lifecycle: each move from one state to another |
| `event_kinds` | The closed list of log kinds, each with its severity, sources and payload keys |
| `operations` | Name, geofence, takeoff security height, state, end reason, creator, and when it started and ended |
| `assignments` | The wayline and the fleet an operation flies, the speed, and the flight the console built |
| `operators` | The operation's pilots and observers, each a live member of its organization |
| `flight_files` | A flight file's bytes, MD5, size, profile version and serving token; members read the identity only |
| `flights` | A prepared flight: assignment, fleet, aircraft, mode (`simulated` or `real`), file, the geofence and envelope it was prepared against, its times and its end reason |
| `flight_states` | The latest progress of each flight: status, DJI result, percent, waypoint, breakpoint and end reason |
| `operation_events` | The append-only log (see [Log](#log)) |
| `telemetry_samples` | Each flight's samples, its track |
| `aircraft_samples` | The latest sample of each aircraft, the one the console shows |
| `operation_checks` | The latest result of each preflight check: state, blocking flag, value, detail and when it was judged |
| `dry_runs` | A flight file's dry run at a stack: pending until judged `valid`, `rejected` or `failed`, with its verdict |
| `transition_requests` | A member's request for an operation to move: pending until decided, with its reasons |

0010 also changes two earlier tables: `command_intents` gets foreign keys to `operations` and `flights`; `stacks` gets `flight_files_url`, `status_read_at` and `envelope_read_at`, and its broadcast also fires when the status or the envelope changes.

### Lifecycle

| Rule | Enforced by |
| --- | --- |
| The state changes only through `soc.move_operation`, which refuses a move the lifecycle does not list and logs `operation_state_changed` with its cause | `soc.move_operation`; trigger `operation_changes` refuses any other change to the state, administrator included |
| Only `soc_operations` may call `soc.move_operation` directly; members ask through `soc.request_transition` | Grants |
| A move into `completed`, `aborted`, `failed` or `cancelled` sets `ended_at` and `end_reason`; `aborted` and `failed` need a reason | `soc.move_operation`; check `operation_ends_with_a_reason` |
| Closed is closed: a closed operation takes no change to its row, assignments, operators, checks, flights, flight files, dry runs, requests or log, except the entry of its closing move | `soc.is_open`, `soc.definition_changed`; triggers `operation_changes`, `operator_changes`, `operation_takes_no_more` |
| A deleted user is forgotten as its creator, open or closed; that is the one change a closed operation's row takes | Foreign key `created_by` on delete set null; trigger `operation_changes` |
| Frozen from `simulating` on: the operation's geofence, height and assignments cannot change in `simulating`, `launching`, `in_flight`, `paused` or `returning`; its operators cannot change from `launching` on | Triggers `operation_changes`, `assignment_changes`, `operator_changes` |
| A wayline, geofence or fleet the operation names cannot change while it simulates or launches, nor while a launch in the simulator flies (0011); a real flight in `in_flight`, `paused` or `returning` keeps its own file and snapshot | Trigger `dependents_follow` |
| A change to what flies while `preparing`, `simulated` or `ready` moves the operation back to `planned`, logging `operation_definition_changed` and the move | `soc.definition_changed` |
| One assignment per operation in the MVP; a wayline or a fleet at most once per operation | Trigger `assignment_changes`; constraints `assignment_wayline_once` and `assignment_fleet_once` |
| A new operation starts as a draft, created by whoever inserts it | Trigger `operation_starts_as_draft` |

### Log

| Rule | Enforced by |
| --- | --- |
| `operation_events` is never updated, deleted or truncated, by any role | Triggers `operation_event_is_kept` and `operation_events_are_kept` |
| The one exception is the organization's erasure: its log goes with it once the organization is gone. The erasure reaches waylines, fleets and geofences before the operations that name them, so deleting one of those first deletes its organization's operations | Trigger `operation_event_is_kept`; triggers `organization_erased_takes_operations` on `waylines`, `fleets` and `geofences` |
| An entry's kind must be in `event_kinds`, with a source and every payload key the kind lists; its severity may be raised, never lowered; `safety` belongs to the safety kinds only | Trigger `operation_event_severity`; foreign key on `kind` |
| `soc.log_event` is the one way to append, granted to `soc_operations` and `soc_cloud`; a closed operation takes only the entry of its closing move | `soc.log_event`, `soc.is_open` |
| The database writes `operation_created`, `operation_state_changed`, `operation_definition_changed`, `transition_requested`, `transition_refused`, `command_requested`, `command_outcome`, `flight_status_changed`, `took_off`, `landed`, `automatic_return` and `geofence_breach` itself | The functions in [Service functions](#service-functions) and the triggers on `operations` and `command_intents` |
| The other kinds are for `soc-cloud` (`geofence_warning`, `telemetry_stale`, `telemetry_fresh`, `fleet_offline`, `fleet_online`) and `soc-operations` (`checks_at_simulation`, `checks_at_launch`, `flight_prepared`, `flight_ended`) to write through `soc.log_event` | `soc.log_event`, against the sources in `events.json` |
| A progress after its flight ended, or on a closed operation, is kept on `flight_states` but neither logged nor announced; a moment on a closed operation keeps its time on the flight but is not logged | `soc.record_flight_progress`, `soc.record_flight_moment` |
| A second geofence breach of a flight records nothing; the first sets `breached_at` and records the return home as sent | `soc.record_geofence_breach` |

### Members' RPCs

| Function | Who may call it | Does |
| --- | --- | --- |
| `soc.request_transition(operation, transition, client_request, meta)` | `authenticated`: an editor or above of the operation's organization; `simulate`, `launch` and `stop` also need a pilot of the operation | Records a pending request and logs `transition_requested`; the same `client_request` gives back the same request; refused on a closed operation |
| `soc.request_command(flight, verb, client_request, meta)` | `authenticated`: an editor or above who is a pilot of the flight's operation | Records a pending command for `pause`, `recovery`, `return_home` or `undo` (the payload of `undo` names the flight); refused on an ended flight, and an `undo` once the flight executes; the same `client_request` gives back the same command |
| `soc.organization_members(organization)` | `authenticated`: the live members of that organization only | Lists them with name, email and role, to name operators from |

Members read their organization's operations, assignments, operators, flights, flight states, log, telemetry, checks and requests; flight files show their identity only, never their bytes or token. Editors create and change operations, and create, change and delete assignments and operators. Members write nothing else directly.

### Service functions

| Function | Called by | Does |
| --- | --- | --- |
| `soc.move_operation(operation, to_state, cause, source, actor, reason)` | `soc_operations` | Moves the state (see [Lifecycle](#lifecycle)) |
| `soc.definition_changed(operation, what, actor)` | `soc_operations`, and the triggers for editors' changes | Logs a change to what flies, and moves a preparing, simulated or ready operation to `planned` |
| `soc.claim_transition_request(request, ttl_s)` | `soc_operations` | Takes a pending request as `running`, or expires it when older than `ttl_s` |
| `soc.decide_transition_request(request, outcome, reasons)` | `soc_operations` | Ends a running request `accepted`, `refused` or `failed`; a refusal or failure is logged with its reasons |
| `soc.record_checks(operation, judged)` | `soc_operations` | Writes the checks that changed, and returns how many |
| `soc.commanding_pilots(operation)` | `soc_operations` | Counts the operation's pilots who are live editors or owners |
| `soc.log_event(...)` | `soc_operations`, `soc_cloud` | Appends one entry |
| `soc.is_open`, `soc.is_terminal`, `soc.is_frozen` | `soc_operations`, `soc_cloud` (the last two also `authenticated`) | Read only |
| `soc.record_aircraft_sample(aircraft, gateway, sample, sampled_at)` | `soc_cloud` | Keeps the aircraft's latest sample; an older one is ignored |
| `soc.record_stack_status(gateway, read)`, `soc.record_stack_envelope(gateway, read)` | `soc_cloud` | Keeps what the stack last said, with when it was read; null when it could not be read |
| `soc.record_stack_files_url(gateway, url)` | `soc_cloud` | Where the stack's dock downloads flight files (`http://`, or null) |
| `soc.record_flight_progress(flight, status, result, percent, waypoint, break_point, end_reason)` | `soc_cloud` | Keeps the progress; logs a status change of an open, unended flight; records an operator's return after a breach as the breach |
| `soc.record_flight_moment(flight, moment, at, mode)` | `soc_cloud` | Keeps the first take-off and the last landing time; logs `took_off`, `landed` or `automatic_return` on an open operation |
| `soc.record_geofence_breach(flight, intent, outside, sampled)` | `soc_cloud` | Once per flight: sets `breached_at`, records the return home as `sent`, logs `geofence_breach` as a safety event; returns whether it did |
| `soc.record_dry_run(run, outcome, verdict)` | `soc_cloud` | Judges a pending dry run `valid`, `rejected` or `failed` |

The command functions `soc_cloud` uses to claim, reply to, fail and time out a command (`claim_command_intent`, `record_command_reply`, `fail_command_intent`, `time_out_command_intent`) are from 0004.

### Notifications

| Channel | Sent when | Payload |
| --- | --- | --- |
| `soc_transition_requests` | a transition request is inserted, at commit | the request's id |
| `soc_command_outcomes` | a command's status changes to anything but `sent` | the command's id |
| `soc_flight_progress` | a flight's status changes on an open, unended flight, or a take-off, landing or automatic return is logged | the flight's id |
| `soc_aircraft_samples` | each call of `soc.record_aircraft_sample`, whether or not the sample is kept | the aircraft's serial |
| `soc_stack_views` | a stack's status or envelope changes | the gateway's serial |
| `soc_dry_runs` | a dry run is inserted | the dry run's id |
| `soc_dry_run_results` | a dry run is judged | the dry run's id |

`soc_command_intents` (0004) announces each new command intent in the same way.

### Broadcasts

Each goes to the organization's private topic `org:<id>:soc:state`, sent by a trigger:

| Event | Sent from | Sent when | Carries |
| --- | --- | --- | --- |
| `operation` | `operations`, `assignments`, `operators` | an operation changes, or an assignment or operator is added, changed or removed | `id`, `state`, `end_reason`, `updated_at` |
| `flight` | `flights` | a flight is inserted or changes | `mode`, the executed, take-off, landing, breach and end times, `end_reason` |
| `flight_state` | `flight_states` | a flight's progress is inserted or changes | status, result, percent, waypoint, breakpoint, `end_reason`, `updated_at` |
| `operation_event` | `operation_events` | each new entry | the whole entry |
| `transition_request` | `transition_requests` | a request is inserted or changes | status, reasons, and the request and decision times |
| `operation_check` | `operation_checks` | a check is inserted or changes | the whole row |
| `stack` | `stacks` | its name, organization, link state, status or envelope changes | `gateway_sn`, `name`, `link_state`, `updated_at` |

`command_intent` (0004) reaches the same topic on every change.

## Rules every migration follows

- Row-level security enabled explicitly on every table: Virtual Origen's trigger
  covers `public` only.
- The caller's membership through `soc.*` helpers; another user's (an operator,
  an organization's members) by reading `public.memberships` and
  `public.organizations` for live rows in a security-definer function. Never
  through the existence of a foreign key: soft-deleted memberships stay in the
  table.
- A foreign key to `public.memberships` is `ON DELETE CASCADE`: Virtual Origen
  deletes users and organizations by cascade, and SOC must not block it.
- Nothing written to `public`.
- Security-definer functions fix their `search_path`, `soc` first and `pg_temp`
  last (`public` and `private` only where they read Virtual Origen's tables), and
  qualify every object.
- Restrictive policies pass every topic or row that is not SOC's through.
- Soft deletes for what is kept as a record: fleets, geofences and waylines
  retire, and operations, flights and the log go only with their organization.
  An open operation's assignments and operators are its definition, deleted
  outright by its editors. Delete events never reach Realtime.
- Never applied while a Virtual Origen release is migrating.

## The fixtures

The tests run against the production images, `supabase/postgres:17.6.1.136`, with
what the other parts of the platform would have created loaded first. Each
generated fixture names the image digests it came from.

| Fixture | What | Source |
| --- | --- | --- |
| `auth-functions.sql` | `auth.uid()`, `role()`, `email()`, `jwt()` as GoTrue v2.189.0 leaves them: they read the JSON claims PostgREST sets, which the image's own versions do not | `generate-auth-functions.sh`, a throwaway GoTrue migrating a throwaway Postgres |
| `realtime-schema.sql` | The `realtime` schema as Realtime v2.102.3 creates it, with the role that owns `realtime.messages` and its grant to `postgres` | `generate-realtime-schema.sh`, a throwaway Realtime migrating a throwaway Postgres |
| `vo2-contract.sql` | Virtual Origen's identity and tenancy surface (VO2's ADR 0059, proposed), loaded as `postgres` as VO2's own runner creates it | Hand-copied from VO2's migrations at `ad7d36a`, each object's source named |

A generator runs only when the platform's versions change; its output is
committed and reviewed like code.

## Running

```bash
uv sync --frozen --all-packages
uv run --frozen pytest database/tests        # needs Docker; about ten seconds
```

The harness starts its own container on a random loopback port and removes it;
it never touches a running Supabase.
