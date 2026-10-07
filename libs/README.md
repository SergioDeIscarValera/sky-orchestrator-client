# Libraries

Python shared by the services, as uv workspace packages. A library holds
mechanism, never a business decision.

| Library | Purpose | Arrives |
| --- | --- | --- |
| `soc-config` | Configuration declared once in `contracts/config/`, loaded and validated at start, fail closed | M1 |
| `soc-log` | JSON log lines carrying the correlation identifiers | M1 |
| `soc-db` | The one direct Postgres connection: `LISTEN`, intent claims, `COPY` | M1 |
| `soc-realtime` | The Realtime Broadcast client: join, heartbeat, send, supervised reconnection | M1 |
| `soc-geo` | Validators: containment with clearance, the local frame, Sky Orchestrator's haversine, held to `contracts/geometry/` | M3 |

Each library has its own gate tests and README.
