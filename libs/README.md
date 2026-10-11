# Libraries

Python shared by the services, as uv workspace packages. A library holds
mechanism, never a business decision.

| Library | Purpose | Arrives |
| --- | --- | --- |
| [`soc-config`](soc-config/README.md) | Configuration declared once in `contracts/config/`, loaded and validated at start, fail closed | M1, here |
| [`soc-log`](soc-log/README.md) | JSON log lines carrying the correlation identifiers | M1, here |
| [`soc-db`](soc-db/README.md) | The one direct Postgres connection, supervised: `LISTEN` then sweep, statements in turn, `COPY` | M1, here |
| [`soc-supervision`](soc-supervision/README.md) | One link kept up: connect, serve until lost, backoff capped at 10 s, health | M1, here |
| [`soc-realtime`](soc-realtime/README.md) | The Realtime Broadcast client: join, heartbeat, send, supervised reconnection, the HTTP fallback | M1, here |
| [`soc-geo`](soc-geo/README.md) | The local frame now, held to `contracts/geometry/` with the console's TypeScript; from M3 the validators: containment with clearance, Sky Orchestrator's haversine | M2, here (the frame); M3 |

Each library has its own gate tests and README.
