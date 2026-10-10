# soc-log

JSON log lines, one object each, carrying the correlation identifiers in force
(`NFR-OBS-01`), on structlog with msgspec rendering
([ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)).

```python
import soc_log

soc_log.configure("soc-cloud")  # once, in main
loop.set_exception_handler(soc_log.asyncio_exception_handler)
log = soc_log.get(__name__)  # safe at import time

with soc_log.correlated(organization=org, flight=flight_id, tid=tid):
    log.info("command_sent", verb="pause")
```

```json
{"time":"2026-10-10T09:12:03.512345Z","level":"info","service":"soc-cloud","logger":"soc_cloud.commands","event":"command_sent","organization":"…","flight":"…","tid":"…","verb":"pause"}
```

- Events are `snake_case` names; values go in fields, never in the event.
- The correlation identifiers are a closed list: `organization`, `operation`,
  `flight`, `command`, `stack`, `device`, `tid`, `bid`. An unknown one is
  refused, so a misspelling cannot split a trail. They are bound per asyncio
  task, so concurrent flights never mix.
- Records of the standard library's logging (asyncpg, aiohttp, aiomqtt),
  uncaught exceptions and asyncio's unhandled errors become lines of the same
  shape, with the identifiers in force.

## Tests

```bash
uv run --frozen mypy libs/soc-log
uv run --frozen pytest libs/soc-log/tests
```

## Failure modes

- A value msgspec cannot encode is written as its `str()`, never dropped.
- A blocked stdout blocks the writer: lines are written and flushed one by one,
  so a container runtime that stops reading stalls the service rather than
  losing lines.
