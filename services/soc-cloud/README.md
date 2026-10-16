# soc-cloud

SOC's DJI cloud party
([ADR-0004](../../docs/architecture/decisions/0004-soc-is-the-dji-cloud-party.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)): one MQTT
link per Sky Orchestrator stack, telemetry to the browsers over Realtime
Broadcast, commands on the wire, the flight files the dock downloads.

## What runs today

The skeleton every later part plugs into:

| Part | Module |
| --- | --- |
| Settings: the contract's keys for `soc-cloud` as typed views, the environment, each stack's secrets; fail closed | `settings.py` |
| The wire contract: Sky Orchestrator's vendored DJI schemas, every outgoing message checked first (`FR-LNK-10`) | `wire.py` |
| The typed client for Sky Orchestrator's wayline API: stack status, the envelope and a dry run of a flight file, a nullable field None when absent or null (`FR-LNK-08`, `FR-LNK-09`) | `so_api.py` |
| Each stack's status and envelope read from its wayline API, every `stack_status_poll_ms` and `stack_envelope_poll_s`, each read recorded as SO returned it or null when it could not be read: an unknown stays unknown, never the last value read. Written for each gateway the stack's link has heard, with when it was read; the latest of each kept while the database is away. Each stack's flight-file address recorded once per gateway and read back (`FR-LNK-08`, `FR-LNK-09`, ADR-0025) | `stacks.py`, through `soc.record_stack_status`, `soc.record_stack_envelope` and `soc.record_stack_files_url` |
| Dry runs of flight files (`FR-LNK-09`, IR-DRY): each pending run judged by the stack its gateway belongs to, the file's bytes and its wayline's takeoff sent to `POST /v1/validations`, the verdict recorded valid or rejected with every problem SO named, or failed with what went wrong; a run for a stack this service does not serve is failed with that reason; swept on every connection | `dry_runs.py`, through `soc.record_dry_run`, listening on `soc_dry_runs` |
| The database link, supervised, as `soc_cloud` | `service.py`, through `soc-db` |
| The Realtime socket, joined to every served organization's telemetry topic | `service.py`, through `soc-realtime` |
| One MQTT v5 link per stack as `cloud-client`, persistent session, supervised (`FR-LNK-01`) | `link/stack.py` |
| Topology and presence: online while listed by `update_topo` and reported online by the dock (`FR-LNK-02`) | `link/topology.py` |
| Each aircraft OSD as one sample at its own time, a missing field unavailable (`FR-LNK-03`) | `link/telemetry.py` |
| Live telemetry to the browsers: each sample as a `sample` event on its stack's organization's `org:<id>:soc:telemetry` (`contracts/broadcast/telemetry.schema.json`), at most `broadcast_max_rate_hz` per aircraft with the latest sample winning, on the socket or through Realtime's HTTP endpoint (`FR-TEL-01`, `NFR-RES-07`) | `fanout.py`, through `soc-realtime` |
| The latencies it can see, logged every minute as one `latency` line with each one's count, p50, p95 and p99: `telemetry_hold_ms` (read to broadcast), `telemetry_age_ms` (the aircraft's timestamp to the read, with the remote controller's clock offset in it), `command_publish_ms` (request to publish), `command_reply_ms` (publish to DJI's reply) and `geofence_return_ms` (a breaching sample read to its return home published) (`NFR-OBS-04`) | `latency.py` |
| Broadcast latency measured on the box (`DEP-23`): `soc-broadcast-probe` joins a member's telemetry topic as the console does and times each `sample` from its `sent_at_ms`, with p50, p95, p99 and max, the reconnects, the longest silence and whether a non-member is refused (`FR-TEL-01`, `NFR-PERF-01`); see [Measuring Broadcast latency](#measuring-broadcast-latency) | `probe.py` |
| What each stack reports, recorded for the console: its link state per dock, the devices it announces with their presence, each aircraft's firmware from `state`; only the latest of each, stacks before their devices, everything again after the database comes back (`FR-FLE-02`, `FR-LNK-02`, `IR-STK`, `IR-DEV`) | `presence.py`, through `soc.record_stack`, `soc.record_topology`, `soc.record_firmware` |
| `update_topo` acknowledged with `status_reply` (`FR-LNK-11`); `flighttask_resource_get` answered on `requests_reply` (`FR-LNK-04`) | `link/stack.py` |
| Flight files kept as exact bytes in memory, offered with their MD5, served at `/files/<128-bit token>.kmz` on `SOC_FLIGHT_FILES_PORT`, retired `flight_file_grace_s` after the flight ends (`FR-LNK-05`, `NFR-SEC-06`, [ADR-0008](../../docs/architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)) | `files.py` |
| Command intents put on the wire: announced by `pg_notify`, swept on every reconnection, checked against their schema, claimed or expired, published with tid = intent and bid = flight, settled by their `services_reply` or timed out (`FR-LNK-06`, ADR-0006) | `commands.py` |
| `flighttask_progress` decoded as sent (status, result, percent, waypoint, break point, media count), and each finished task's end reason (`FR-LNK-07`); read from `events` by the link and handed to the flights | `link/progress.py`, `link/stack.py` |
| The flights: each watched from its prepare, its file kept under the database's token before the prepare goes out, until soc-operations ends it (read again every 5 s and on every connection). While it executes, every sample judged against its geofence snapshot: the first outside sends `return_home` on the wire before any write, then records it with the breach, once per flight, across a restart (`FR-SAF-01`, ADR-0010); entering the warning band logs `geofence_warning`. Take-off, landing and the aircraft's own return from its flight mode; the track at the first sample of each second, one insert every `telemetry_batch_s`; no sample for `telemetry_stale_after_ms` logs `telemetry_stale` once and sends nothing (`FR-SAF-06`), the next sample `telemetry_fresh`; the aircraft going offline or online logged. Each progress recorded with its end reason. Every aircraft's latest sample recorded as broadcast, for the checks (ADR-0025). Records written in order, once, through a database that goes away | `flights.py`, through `soc.record_flight_progress`, `soc.record_flight_moment`, `soc.record_geofence_breach`, `soc.record_aircraft_sample`, `soc.log_event` and `soc.telemetry_samples` |
| `/health` and `/ready` on `SOC_HEALTH_PORT`, one entry per part: `database`, `realtime`, `flight_files`, `stack:<name>` (`NFR-OBS-02`) | `service.py`, through `soc-supervision` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |

The topics read are those a DJI cloud reads (`link/topics.py`): `status`,
`osd`, `state`, `events`, `requests`, `services_reply`, `property/set_reply`,
at QoS 1. The history of each flight's samples arrives with the flights (M4),
and the flight files enter the registry
from `soc.flight_files` with the operations in M4 ([roadmap](../../docs/roadmap.md)).
Each stack offers the files at its own `flight_files_url`: the address the dock
reaches `soc-cloud` at on that stack's network.

## Running it

```bash
uv run soc-config example soc-cloud > /etc/soc/soc-cloud.json   # then fill the blanks
SOC_CONFIG_FILE=/etc/soc/soc-cloud.json ... uv run soc-cloud
```

Each stack names the organization its aircraft fly for, one of
`served_organizations` (contract 2.0.0): its stack, devices, fleets, telemetry
and commands are that organization's.

Every variable it reads is declared in `contracts/config/soc-config.schema.json`
(`x-environment`), plus the broker password and API token each stack names. At
start it logs `service_started` with the configuration's fingerprint and the
contract version.

## Measuring Broadcast latency

`soc-broadcast-probe` runs in this image, beside soc-cloud, so both read the same
clock. It signs in as a member through GoTrue, joins the organization's telemetry
topic through Kong as a private channel, as the console does, and times every
`sample` from its `sent_at_ms` to its arrival. A dropped socket is joined again
under backoff. Before the run and after it, it asks Realtime whether a non-member's
join is refused. From `infra/compose`, with the credentials in the shell and never
in a file:

```bash
docker compose run --rm --no-deps -e SOC_PROBE_ANON_KEY -e SOC_PROBE_EMAIL -e SOC_PROBE_PASSWORD \
  --entrypoint soc-broadcast-probe soc-cloud --supabase-url http://kong:8000 --organization <id>
```

Add `-e SOC_PROBE_OUTSIDER_EMAIL -e SOC_PROBE_OUTSIDER_PASSWORD` to check the refusal
too: without them the refusal is not measured, and DEP-23 needs it. The options are
`--seconds` (default 600) and `--max-p95-ms` (default 150). The secrets come only from
the environment; the probe prints none of them.

It prints one JSON object on stdout: `samples`, `p50_ms`, `p95_ms`, `p99_ms`,
`max_ms`, `reconnects`, `longest_gap_ms` (the longest silence on the topic, counting
the time before the first sample and after the last) and `outsider_refused` (`null`
when no non-member was checked). Logs are JSON lines on stderr. The exit status is:

- `0`: at least one sample arrived, p95 is within `--max-p95-ms`, the non-member was
  refused when checked, and a sample arrived after the member's last rejoin;
- `1`: one of those is not so; each reason is a `probe_failed` line on stderr;
- `2`: an argument or a variable is missing or wrong, named on stderr.

The probe measures soc-cloud to a client on the mini-PC, through Kong and Realtime:
the server path a browser takes. It does not measure the LAN hop to a laptop, nor
the browser's rendering (the console's own figure is `?stats`, `NFR-OBS-05`). Each
latency is the probe's wall clock at arrival minus `sent_at_ms`, both read on the
same host, so no clock offset is in it.

## Tests

```bash
uv run --frozen mypy services/soc-cloud
uv run --frozen pytest services/soc-cloud/tests -m "not lane"   # gate
uv run --frozen pytest services/soc-cloud/tests -m lane         # lane, needs Docker
```

- The settings read exactly the keys the contract gives `soc-cloud`, nested
  views included (`FR-DEP-03`); no secret shows in them.
- The probe (`test_probe.py`): the percentiles, the silence, the verdict and each of
  its reasons, the frame decoding, the redaction and the arguments; the GoTrue
  password grant against a local server, its refusal naming no credential; the
  member's join with its token and the private topic, its timed samples, a dropped
  socket joined again and counted, a missing heartbeat replacing the socket, a
  refused join named, a refused sign-in ending the run; and the non-member refused
  or not, against `soc_realtime.testing.FakePhoenix`.
- The probe on the container lane, against Virtual Origen's platform with GoTrue,
  Kong and Realtime, is in `infra/e2e`, which holds that platform.
- Never invented (`FR-SAF-03`): the OSD's structs, its mapping to a sample and
  the broadcast payload are searched through their syntax tree for any way to
  fill a missing value (`or`, a conditional falling back to a value, `.get`
  with a default, a field defaulting to other than None), the search held to
  planted cases; an OSD with no measurement is broadcast with each one None.
- Every vendored example passes its schema; a reply missing its result is
  refused with the reason; the envelope is enforced through its reference.
- A refused configuration stops the process with exit status 2 and one
  `configuration_refused` line naming every problem.
- The stacks, against fakes of the wayline API and the database: each status and
  envelope recorded as the stack returned it; a field the stack does not know
  null; an unreachable stack recorded null, and its value again once it answers;
  a stack that hangs delays no other; the flight-file address recorded once per
  gateway, read back, and written again while the stack's row is not there; the
  latest reading kept while the database is away, and a refused one dropped;
  each change of reachability logged once, not every read.
- The dry runs, against fakes of the validation API and `soc.dry_runs`: valid,
  rejected with every problem, failed with the error; a run for a stack this
  service does not serve failed with the reason; the file and its takeoff sent
  as SO takes them (latitude first); the sweep finds what is pending; a run
  announced twice judged once; a database away at the sweep or at the verdict.
- On the container lane, against Postgres with SOC's migrations: a status
  written to its stack and announced on `soc_stack_views`; an envelope written;
  the files address read back; a status read over HTTP from a loopback wayline
  API reaching the row, and null once that API stops answering; a dry run
  inserted by `soc_operations` judged end to end through the whole service on
  the wayline API, with the file and takeoff received, latitude first; a dry run
  waiting while the service was away judged by its first sweep; a run for an
  unserved stack failed; a judgement the API refuses failed with its words.
- The link, driven with Sky Orchestrator's own example messages: the
  acknowledgement, presence both ways, samples, the file request answered or
  refused, a reply its schema refuses never sent, unreadable messages dropped,
  the session's options, a takeover told from a lost broker.
- On the container lane, against Mosquitto 2.0.22 configured as Sky
  Orchestrator's broker (`soc_cloud.testing.EphemeralMosquitto`): the
  acknowledgement and presence, samples, 100 file requests answered with p99
  under 500 ms, a message sent while SOC was away delivered when it returns, the
  link back after the broker restarts, a takeover reported.
- The flight files: the MD5 and the 128-bit path, each stack's own address,
  the same bytes kept twice changing nothing, other bytes for the same flight
  refused, the grace after the flight, the exact bytes downloaded, every other
  path the same 404.
- The commands, driven through a real stack link on the fake client: published
  with tid and bid, an intent announced three times run once, replies settling
  and stopping the clock, a timeout, an expiry, a schema refusal, a command
  waiting for its dock and running when the dock is announced, one expiring when
  it never is, a publish lost after the claim timing out, the sweep running
  what was missed and settling what was left sent; a prepare going out only
  once its file is kept, failed when it cannot be; every reply recorded
  reported as settled; soc-cloud's own return published before any record,
  its reply held until the record and settling it once, a never-recorded one
  let go, one recorded late timing out from when it was sent.
- The flights, against fakes of the store and the wire: the file kept under the
  database's token; executing from the execute accepted or a progress in
  flight; the first sample outside, or above the ceiling, returning the
  aircraft once, before any write, tried again when the publish failed, never
  again across a restart; the warning band warned once per entry, an unknown
  sample not inside; take-off, return and landing from the mode, none invented
  after a restart; the first sample of each second in one insert, ten minutes
  at 5 Hz with jitter storing 600 ± 1 (`FR-TEL-04`); telemetry stale once and
  no command, fresh again; each progress with its end reason; presence logged;
  records in order and once through a database away, busy or refusing.
- On the container lane, the service starts from a written file and environment
  against Postgres and Realtime v2.102.3 with SOC's migrations and the broker,
  and answers `/ready` with every part up; then the dock asks for a flight's
  file over MQTT and downloads it, its MD5 equal to the fingerprint offered.
  100 commands committed by `soc_operations` reach the wire with **p95 under
  50 ms from commit to claim**, each published once and accepted; a command
  committed while `soc-cloud` was away runs once when it returns, and a stale one
  expires. A flight crossing its geofence through the broker is returned
  **2.5 ms** after the dock published the sample (`FR-SAF-01` asks 100 ms), once,
  and once again across a restart; its take-off, breach, command, return,
  progress and landing land in the log as `soc_cloud`, the breach as safety and
  the task's end as `geofence_breach`; its track and latest sample are stored.
- On the container lane, the flights' store as `soc_cloud`: the flights not
  ended with what was seen of them, a file's bytes and token, a track sample
  written twice ignored rather than refusing its batch, the latest sample kept
  and announced, a closed operation's log left alone, a breach once.
- In the console end to end (`infra/e2e`), the service runs in its process on
  one stack behind Kong, as on the mini-PC, while a dock announces and flies an
  aircraft: the console shows it within 2 s and every sample reaches Chrome in
  order, 28 ms at p95 from the dock's publish.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting, variable or stack secret | The process exits with status 2 before opening any connection, naming every problem |
| Postgres unreachable, or the password refused | The database link stays down, retried up to every 10 s; `/ready` answers 503 naming the error |
| Realtime unreachable, a join refused, a heartbeat unanswered | The socket is replaced under supervision; `/ready` answers 503 meanwhile; telemetry falls back to HTTP once it flows |
| Realtime's socket and HTTP endpoint both unreachable | The samples due are dropped, counted and logged as `telemetry_dropped`; the next ones go out as soon as either is back; nothing old is replayed |
| A stack's broker unreachable, or the password refused | That stack's link stays down, retried up to every 10 s; `/ready` answers 503 naming it; the other stacks are unaffected |
| Another client connects as `cloud-client` | The broker ends SOC's session; SOC logs `link_displaced`, health names it, and it takes the session back after the backoff. Mosquitto 2.0.22 ends a taken-over session with a normal DISCONNECT, not reason 142, so a clean end from the server is read as a takeover |
| A message from the dock SOC cannot read | Dropped with a `message_unreadable` line; the link stays up |
| A reply SOC builds breaks its schema | It is not published; `reply_refused_by_schema` names every problem; the dock times out as it would without a reply |
| A file request for a flight SOC does not know | Answered with a non-zero result and the reason; the dock refuses the execute with 314013 and the task stays prepared |
| A request for any path but a live file's | The same 404, whether the token is unknown, malformed, retired or the path is a directory |
| Other bytes kept for a flight that already has a file | Refused with `FlightFileConflictError`: what flies is what was kept (`IR-FIL-01`) |
| The flight file port cannot be bound | The process ends with status 1 and `service_failed` |
| The database away while stacks report | The latest of each report is kept and written when it is back, every one of them again; nothing reported meanwhile is lost, nothing stale is written last |
| The database refuses a report (a serial it does not accept, a stack moved to another organization while it has fleets) | `presence_refused` names it; that report is dropped, the others are written |
| A command for a dock no connected stack has announced | It waits; it runs when a stack announces the dock, or expires once `command_intent_ttl_s` has passed |
| A command claimed but not published (the broker dropped) | It stays `sent` and times out after `command_reply_timeout_s`: nothing claims it twice |
| A command its schema refuses | `failed` before anything is sent, with every problem logged |
| A stack's wayline API unreachable, refused, or with no answer within the interval | That read is recorded null (unknown) at once, never the last value; `stack_api_unreachable` is logged when it starts and `stack_api_reachable` when it answers again; the other stacks are unaffected |
| A status or envelope read with a body its schema refuses | Recorded null, as an unreachable read is; the error is logged with the change of reachability |
| The database away while a stack reads | The latest reading of each is kept and written when the database is back, the older ones never written after it |
| A stack's row not there yet when a reading or its flight-file address is written | The database does nothing for that write. The address is read back and written again with the next reading until the row shows it; a status or envelope is written by the next reading, within a second for the status and within its interval for the envelope |
| A dry run for a stack this service does not serve | Failed at once with `stack <name> is not served by this soc-cloud`; nothing is sent to any stack |
| A dry run the stack cannot judge (unreachable, refused, a body it cannot read) | Failed, its verdict `{"error": ...}` with what the stack said; recorded once |
| The database away while a dry run is judged | The verdict is kept and recorded when the database is back, and the stack is not asked again. A run the process stopped before judging stays pending until the sweep on the next connection |
| A dry run announced while the service is away | Found by the sweep on the next connection and judged then |
| A dry run the database refuses to record | `dry_run_refused` is logged; the run stays pending until the next sweep |
| `soc-cloud` restarts with commands in flight | The sweep runs what is pending, times out what was sent too long ago, and waits for the replies of the rest |
| A prepare whose flight or file is not in the database, or whose token cannot be served | `failed` before anything is sent, with `flight_file_not_found` or `flight_file_not_kept` |
| A sample outside the geofence of an executing flight | `return_home` is published at once, before any write (2.5 ms from the dock's sample to the dock's services topic on a local broker); the breach and the command are recorded after, and its reply, even one heard first, settles the command once recorded. Later samples outside send nothing, and neither does a restart: the flight keeps `breached_at` |
| The return home cannot be published (no link to the dock, the broker dropped) | `geofence_return_not_sent` is logged; the next sample outside tries again. The device's own geofence and link-loss policy still apply (NFR-SAF-01) |
| A flight's geofence snapshot that cannot be judged against | `flight_geofence_unusable` is logged when the flight is watched; its samples are not judged. soc-operations validated it before the prepare, so this is a bug, never a flight's normal state |
| No sample of an executing flight for `telemetry_stale_after_ms` | `telemetry_stale` (safety) is logged once and nothing is sent: link loss is the device's policy (FR-SAF-06). A flight on the ground after its task ended is not watched for it |
| The database away while flights report | The progress, moments, breaches and log entries wait in order and are written when it is back, each once; the track waits for the next batch; only each aircraft's latest sample is kept |
| The database refuses a flight's record | `flight_record_refused` names it and the next record is written; a refused breach lets its command's reply go, and the command times out in the database's sweep |
| A progress with no status or naming no flight | `flight_progress_unusable` is logged and nothing is recorded |
| A track sample written twice (redelivered after a reconnection) | The second is ignored by the database, never refused with its batch |
| A bug in a supervised part | The process ends with status 1 and a `service_failed` line, and the container restarts |
| SIGTERM | Every link closes and the process exits with status 0 |
| `soc-broadcast-probe`: the member's password refused | The run ends at once with status 1, naming the status and code (`sign-in refused: HTTP 400 invalid_credentials`), never the credential |
| `soc-broadcast-probe`: Realtime restarted during the run | The socket is closed and joined again under backoff, at most 10 s between attempts; the silence shows in `longest_gap_ms`; status 0 only if a sample follows the rejoin |
| `soc-broadcast-probe`: Realtime recreated while Kong still holds its old address | The rejoin fails until Kong resolves Realtime again; no sample follows the rejoin, so the run ends with status 1 and `did not rejoin` |
| `soc-broadcast-probe`: a non-member's join goes through | Status 1: `the outsider joined the topic: its join was not refused` |
| `soc-broadcast-probe`: a sample without a whole `sent_at_ms` | Counted and named; status 1, since the producer broke the contract |
