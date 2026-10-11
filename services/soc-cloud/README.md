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
| The database link, supervised, as `soc_cloud` | `service.py`, through `soc-db` |
| The Realtime socket, joined to every served organization's telemetry topic | `service.py`, through `soc-realtime` |
| One MQTT v5 link per stack as `cloud-client`, persistent session, supervised (`FR-LNK-01`) | `link/stack.py` |
| Topology and presence: online while listed by `update_topo` and reported online by the dock (`FR-LNK-02`) | `link/topology.py` |
| Each aircraft OSD as one sample at its own time, a missing field unavailable (`FR-LNK-03`) | `link/telemetry.py` |
| `update_topo` acknowledged with `status_reply` (`FR-LNK-11`); `flighttask_resource_get` answered on `requests_reply` (`FR-LNK-04`) | `link/stack.py` |
| Flight files kept as exact bytes in memory, offered with their MD5, served at `/files/<128-bit token>.kmz` on `SOC_FLIGHT_FILES_PORT`, retired `flight_file_grace_s` after the flight ends (`FR-LNK-05`, `NFR-SEC-06`, [ADR-0008](../../docs/architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)) | `files.py` |
| Command intents put on the wire: announced by `pg_notify`, swept on every reconnection, checked against their schema, claimed or expired, published with tid = intent and bid = flight, settled by their `services_reply` or timed out (`FR-LNK-06`, ADR-0006) | `commands.py` |
| `/health` and `/ready` on `SOC_HEALTH_PORT`, one entry per part: `database`, `realtime`, `flight_files`, `stack:<name>` (`NFR-OBS-02`) | `service.py`, through `soc-supervision` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |

The topics read are those a DJI cloud reads (`link/topics.py`): `status`,
`osd`, `state`, `events`, `requests`, `services_reply`, `property/set_reply`,
at QoS 1. The samples are kept in memory; the fan-out to the browsers and the
devices in the database arrive in M2, and the flight files enter the registry
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

## Tests

```bash
uv run --frozen mypy services/soc-cloud
uv run --frozen pytest services/soc-cloud/tests -m "not lane"   # gate
uv run --frozen pytest services/soc-cloud/tests -m lane         # lane, needs Docker
```

- The settings read exactly the keys the contract gives `soc-cloud`, nested
  views included (`FR-DEP-03`); no secret shows in them.
- Every vendored example passes its schema; a reply missing its result is
  refused with the reason; the envelope is enforced through its reference.
- A refused configuration stops the process with exit status 2 and one
  `configuration_refused` line naming every problem.
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
  what was missed and settling what was left sent.
- On the container lane, the service starts from a written file and environment
  against Postgres and Realtime v2.102.3 with SOC's migrations and the broker,
  and answers `/ready` with every part up; then the dock asks for a flight's
  file over MQTT and downloads it, its MD5 equal to the fingerprint offered.
  100 commands committed by `soc_operations` reach the wire with **p95 under
  50 ms from commit to claim**, each published once and accepted; a command
  committed while `soc-cloud` was away runs once when it returns, and a stale one
  expires.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting, variable or stack secret | The process exits with status 2 before opening any connection, naming every problem |
| Postgres unreachable, or the password refused | The database link stays down, retried up to every 10 s; `/ready` answers 503 naming the error |
| Realtime unreachable, a join refused, a heartbeat unanswered | The socket is replaced under supervision; `/ready` answers 503 meanwhile; telemetry falls back to HTTP once it flows |
| A stack's broker unreachable, or the password refused | That stack's link stays down, retried up to every 10 s; `/ready` answers 503 naming it; the other stacks are unaffected |
| Another client connects as `cloud-client` | The broker ends SOC's session; SOC logs `link_displaced`, health names it, and it takes the session back after the backoff. Mosquitto 2.0.22 ends a taken-over session with a normal DISCONNECT, not reason 142, so a clean end from the server is read as a takeover |
| A message from the dock SOC cannot read | Dropped with a `message_unreadable` line; the link stays up |
| A reply SOC builds breaks its schema | It is not published; `reply_refused_by_schema` names every problem; the dock times out as it would without a reply |
| A file request for a flight SOC does not know | Answered with a non-zero result and the reason; the dock refuses the execute with 314013 and the task stays prepared |
| A request for any path but a live file's | The same 404, whether the token is unknown, malformed, retired or the path is a directory |
| Other bytes kept for a flight that already has a file | Refused with `FlightFileConflictError`: what flies is what was kept (`IR-FIL-01`) |
| The flight file port cannot be bound | The process ends with status 1 and `service_failed` |
| A command for a dock no connected stack has announced | It waits; it runs when a stack announces the dock, or expires once `command_intent_ttl_s` has passed |
| A command claimed but not published (the broker dropped) | It stays `sent` and times out after `command_reply_timeout_s`: nothing claims it twice |
| A command its schema refuses | `failed` before anything is sent, with every problem logged |
| `soc-cloud` restarts with commands in flight | The sweep runs what is pending, times out what was sent too long ago, and waits for the replies of the rest |
| A bug in a supervised part | The process ends with status 1 and a `service_failed` line, and the container restarts |
| SIGTERM | Every link closes and the process exits with status 0 |
