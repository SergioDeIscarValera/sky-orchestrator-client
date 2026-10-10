# soc-db

A service's one direct Postgres connection, supervised
([ADR-0006](../../docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)).

```python
from soc_db import Database, Target

database = Database(
    Target(host, port, "postgres", "soc_cloud", password, application_name="soc-cloud"),
    listeners={"soc_intents": on_intent},
    on_connected=sweep_pending_intents,
)
async with asyncio.TaskGroup() as group:
    group.create_task(database.run())
    ...

async with database.transaction() as connection:
    claimed = await connection.fetchrow(CLAIM, intent_id)
await database.copy_records("telemetry_samples", rows, COLUMNS)
```

- **Listen, then sweep.** On every connection and reconnection it `LISTEN`s on
  every channel first, then calls `on_connected`: an intent committed while the
  service was away is found by the sweep, and one committed during the sweep is
  announced. Handlers must tolerate seeing an intent twice; a claim is one
  conditional update, so it runs once.
- **Notifications** reach their handler one at a time, in arrival order. A
  handler that raises is logged and the next one still runs. A handler must not
  block: it starts its own task for long work.
- **One statement at a time.** `session()` and `transaction()` take turns on the
  connection, waiting up to 5 s for one to exist, then raise
  `DatabaseUnavailableError`.
- **Supervised.** A refused connection is retried after 0.5, 1, 2, 4, 8, then
  every 10 s (`NFR-REL-03`); a connection the server closes, or that fails its
  ping every 15 s, is replaced. `health` says whether it is up, since when, and
  the last error.
- **Kept honest on the server.** The connection names itself
  (`application_name`) and asks the server to probe it (TCP keepalives after
  10 s, every 5 s, 3 probes): a client that vanished does not keep one of the
  role's three connections for hours.

## Tests

```bash
uv run --frozen mypy libs/soc-db
uv run --frozen pytest libs/soc-db/tests -m "not database"   # gate: a fake server
uv run --frozen pytest libs/soc-db/tests -m database         # lane: a real Postgres
```

The gate drives the supervisor against a fake server: backoff, listen before the
sweep, replacement on loss and on a failed ping, ordered notifications, turns on
the connection, a bug in the sweep stopping the service. The lane, on the
production Postgres image with SOC's migrations: the role's settings as applied,
a notification only after its transaction commits, a terminated backend replaced
and swept again, `COPY` into a `soc` table.

## Failure modes

- A statement in flight when the connection drops raises asyncpg's error to its
  caller; the next session waits for the replacement.
- A bug in `on_connected` stops `run()` with the error rather than reconnecting
  in a loop: the container restarts and the log says why.
- A notification sent while disconnected is lost by Postgres; the sweep on
  reconnection is what finds its row.
