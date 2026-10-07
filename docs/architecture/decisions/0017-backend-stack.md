# ADR-0017 — Backend stack: small asyncio services, one database connection each

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

`soc-cloud` holds MQTT connections to Sky Orchestrator stacks, a WebSocket to
Realtime, a database connection, an HTTP server for flight files and an HTTP
client for SO's surfaces, all at once, all mostly idle. `soc-operations` holds a
database connection and SO's HTTP surfaces. Both run on a mini-PC shared with a
farm and must stay within 64 MB at rest (`NFR-RES-04`).

Sky Orchestrator's services are threaded paho-mqtt with Flask; Virtual Origen's
are asyncio with supabase-py and pydantic. Sky Orchestrator measured what costs
memory and CPU in idle Python services (its ADR-0032): health probes that start
Python, loops that wake for nothing, uncompiled images, per-thread malloc arenas,
and heavy client libraries.

Versions read from PyPI and Docker Hub on 2026-10-07; a smoke suite with these
pins passed on CPython 3.14.8, including inside the pinned image, with an MQTT v5
round trip against Mosquitto.

## Decision

| Slot | Choice | Version | Why |
| --- | --- | --- | --- |
| Language | CPython | 3.14.8 | Every compiled dependency has its wheel; 3.15.0 is days old and pydantic-core lacks its wheels |
| Project and locks | uv workspace | 0.12.23 | One lockfile with hashes, `uv sync --frozen` |
| Concurrency | asyncio | stdlib | Several long-lived connections per process, all mostly waiting |
| MQTT | aiomqtt | 2.5.x | MQTT v5 on asyncio, over paho 2.1.0 |
| Database | asyncpg | 0.32.0 | One direct connection per service: `LISTEN` for intents (ADR-0006), claims, `COPY` for telemetry history |
| Realtime | SOC's own Phoenix-channel client on websockets | 17.2 | A join, a heartbeat and broadcasts; supervised reconnection. `realtime` on PyPI pulls in pydantic and pins an older websockets |
| HTTP, both ways | aiohttp | 3.14.4 | Client for SO's surfaces and the Realtime fallback; server for flight files and health |
| Data shapes | msgspec | 0.22.0 | Typed structs, JSON decoding with validation, configuration; a fraction of pydantic's memory |
| Wire validation | jsonschema-rs | 0.58.6 | SO's vendored DJI schemas checked before anything is published (`FR-LNK-10`); the reference `jsonschema` 4.26.0 as a test oracle |
| Logs | structlog | 26.1.0 | JSON lines with correlation identifiers bound per task (`NFR-OBS-01`) |
| Flight files | stdlib `xml.etree`, `zipfile` | stdlib | Deterministic KMZ, fixed timestamps (ADR-0008) |
| Tests | pytest, pytest-asyncio, hypothesis | 9.1.1, 1.4.0, latest | Gate tests under 2 s per unit |
| Types, lint | mypy strict, ruff | 2.4.0, 0.16.10 | In the gate |
| Test oracles only | shapely, pyproj, geographiclib, jsonschema | 2.2.x, 3.8.0, 2.1, 4.26.0 | Generate and check golden vectors (ADR-0009); never imported at runtime |
| Image | python 3.14.8-slim-trixie | by digest | Compiled at build, `MALLOC_ARENA_MAX=2`, non-root, read-only root filesystem, health probe in bash over `/dev/tcp` |

**Database access**: each service connects directly to Postgres on Virtual
Origen's network, with its own login role holding the least privilege its work
needs on schema `soc` (`soc_cloud`, `soc_operations`), never the superuser. The
Supabase service key is used only where Realtime requires it, to publish
Broadcast messages.

**Shared code** lives in `libs/` as workspace packages: configuration, logs, the
database connection, the Realtime client, geometry validators.

## Alternatives considered

**supabase-py with PostgREST**, as Virtual Origen does. No direct connection, and
no `LISTEN`, no `COPY`, an HTTP round trip per statement, and pydantic in every
service.

**Threaded paho with Flask**, as Sky Orchestrator does. Proven, and two
concurrency models in a process holding five kinds of connection.

**pydantic for data shapes.** The ecosystem default; several times msgspec's
memory for what is here decoding and validating a few message shapes.

**httpx** as the HTTP client. No stable release since 2024, and a server would
still be needed.

## Consequences

- SOC writes its own small Realtime client, with tests against a fake server and
  against the real Realtime in the stack check.
- Two login roles are created in Virtual Origen's database by SOC's migrations,
  their passwords from the environment.
- No dependency here is heavy; the footprint is measured from the first service
  (`NFR-RES-04`).
