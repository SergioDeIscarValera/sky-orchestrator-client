# ADR-0002 — Monorepo layout and service boundaries

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

SOC has a browser application with an always-on 3D scene, backend work that must
run next to Sky Orchestrator's broker, a database schema, and interfaces between
all of them. Two questions: one repository or several, and how the backend is
split.

Two facts constrain the split. Sky Orchestrator accepts exactly one connection
per Cloud API credential, and one credential exists per Sky Orchestrator stack:
a second connection takes the session over. And everything runs on one mini-PC
that already hosts Virtual Origen and Sky Orchestrator, so every extra process
costs memory that is shared with a farm's control loop.

## Decision

**One repository**, with one directory per deploy unit or concern:

| Path | Owns | Does not own |
| --- | --- | --- |
| `apps/soc-web/` | The interface: the persistent 3D scene, the panels, the interactive geometry that previews designs as the user draws, and the intents the user expresses | The DJI wire, authoritative validation |
| `services/soc-cloud/` | The DJI cloud party: one MQTT connection per Sky Orchestrator stack, topology and presence, telemetry fan-out and history, commands on the wire, answers to the dock's requests, the flight files the dock downloads, the cloud geofence monitor | Operation lifecycle, mission design |
| `services/soc-operations/` | The operation lifecycle and its state machine, preflight evaluation, the simulation gate, flight file production, operation records and accounting | MQTT, the DJI wire format |
| `libs/` | Python shared by the services: configuration, logging, data access, geodesy and polygon predicates | Business decisions |
| `database/` | Schema `soc`: tables, row-level security, RPCs, migrations, their tests | Virtual Origen's `public` schema |
| `contracts/` | Interfaces between units: broadcast payloads, command verbs, geometry golden vectors, Sky Orchestrator's schemas vendored by version | Implementations |
| `infra/` | The compose stack for the mini-PC, the migration runner, live checks | Business logic |
| `tools/` | Repository tooling | Business logic |

**Two backend services.** The wire is one process because the broker allows one
connection per stack. Everything the wire does not need sits in the second, so a
fault in operation logic can never drop the link to an aircraft in flight.

Units meet at `contracts/` and at the database, never at each other's internals.

## Alternatives considered

**One backend service.** Less memory, no internal hop. Rejected: a defect in
report generation or file production would share a process with the only link
to a flying aircraft, and the DJI wire format would leak into lifecycle code.

**Four services** (a separate telemetry recorder, file server and planner). Each
of them either needs the MQTT connection, which cannot be shared, or data the
wire process already holds. On one host this buys memory use, not isolation.

**Separate repositories per unit.** The contracts between the web, the services
and the schema change together; changes landing in several repositories at
different times would be changes nobody can review as a whole.

**A backend API for the browser.** Rejected in ADR-0006.

## Consequences

- Two agent sessions can work in different units without touching the same
  files. When they must, it is a contract change, visible as such.
- Every cross-unit change shows up in `contracts/` or `database/`.
- A request spans the browser, the database and up to two services, so
  correlation identifiers are required from the first release (`NFR-OBS-01`).
