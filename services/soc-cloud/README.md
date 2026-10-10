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
| `/health` and `/ready` on `SOC_HEALTH_PORT`, one entry per link (`NFR-OBS-02`) | `service.py`, through `soc-supervision` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |

The MQTT links per stack and the flight file server arrive next
([roadmap](../../docs/roadmap.md), M1).

## Running it

```bash
uv run soc-config example soc-cloud > /etc/soc/soc-cloud.json   # then fill the blanks
SOC_CONFIG_FILE=/etc/soc/soc-cloud.json ... uv run soc-cloud
```

Every variable it reads is declared in `contracts/config/soc-config.schema.json`
(`x-environment`), plus the broker password and API token each stack names. At
start it logs `service_started` with the configuration's fingerprint and the
contract version.

## Tests

```bash
uv run --frozen mypy services/soc-cloud
uv run --frozen pytest services/soc-cloud/tests -m "not database"   # gate
uv run --frozen pytest services/soc-cloud/tests -m database         # lane, needs Docker
```

- The settings read exactly the keys the contract gives `soc-cloud`, nested
  views included (`FR-DEP-03`); no secret shows in them.
- Every vendored example passes its schema; a reply missing its result is
  refused with the reason; the envelope is enforced through its reference.
- A refused configuration stops the process with exit status 2 and one
  `configuration_refused` line naming every problem.
- On the database lane, the service starts from a written file and environment
  against Postgres and Realtime v2.102.3 with SOC's migrations, and answers
  `/ready` with both links up.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting, variable or stack secret | The process exits with status 2 before opening any connection, naming every problem |
| Postgres unreachable, or the password refused | The database link stays down, retried up to every 10 s; `/ready` answers 503 naming the error |
| Realtime unreachable, a join refused, a heartbeat unanswered | The socket is replaced under supervision; `/ready` answers 503 meanwhile; telemetry falls back to HTTP once it flows |
| A message SOC builds breaks its schema | It is not published; the caller gets `WireRefusedError` with every problem |
| A bug in a supervised part | The process ends with status 1 and a `service_failed` line, and the container restarts |
| SIGTERM | Every link closes and the process exits with status 0 |
