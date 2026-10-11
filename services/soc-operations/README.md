# soc-operations

SOC's operations
([ADR-0002](../../docs/architecture/decisions/0002-monorepo-and-service-boundaries.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)): the
operation lifecycle and its state machine, the preflight checks, the simulation
gate, and the flight files `soc-cloud` serves.

## What runs today

The skeleton the operations plug into:

| Part | Module |
| --- | --- |
| Settings: the contract's keys for `soc-operations` as a typed view, the environment; fail closed | `settings.py` |
| The database link, supervised, as `soc_operations`, which may request commands (`soc.command_intents`) | `service.py`, through `soc-db` |
| `/health` and `/ready` on `SOC_HEALTH_PORT` (`NFR-OBS-02`) | `service.py`, through `soc-supervision` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |

The operations, their transitions and the intents they execute (ADR-0006)
arrive with the operations data model in M4 ([roadmap](../../docs/roadmap.md)).

## Running it

```bash
uv run soc-config example soc-operations > /etc/soc/soc-operations.json
SOC_CONFIG_FILE=/etc/soc/soc-operations.json ... uv run soc-operations
```

## Tests

```bash
uv run --frozen mypy services/soc-operations
uv run --frozen pytest services/soc-operations/tests -m "not lane"   # gate
uv run --frozen pytest services/soc-operations/tests -m lane         # lane, needs Docker
```

The settings read exactly the keys the contract gives `soc-operations`, each
removed key stops the start naming it, no secret shows; a refused configuration
exits with status 2 and one line naming every problem; on the container lane the
service comes up ready on the production Postgres image as `soc_operations`.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting or variable | The process exits with status 2 before opening any connection, naming every problem |
| Postgres unreachable, or the password refused | The database link stays down, retried up to every 10 s; `/ready` answers 503 naming the error |
| A bug in a supervised part | The process ends with status 1 and a `service_failed` line |
| SIGTERM | The link closes and the process exits with status 0 |
