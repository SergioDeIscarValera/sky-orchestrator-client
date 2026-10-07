# ADR-0007 — Everything live travels as Realtime Broadcast on private channels

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Each aircraft publishes its OSD at Sky Orchestrator's configured rate: 1 Hz
measured on the phone, 5 Hz planned. A handful of browsers follow it on the LAN.
They also need, promptly, every change of an operation, a flight, a command and
the log.

Facts about Realtime v2.102.3 on the mini-PC, read in its source and Supabase's
documentation:

- **Postgres changes** go through a poller that waits 500 ms when idle, one
  thread per tenant, shared with Virtual Origen, with a row-level-security check
  per subscriber per change. Virtual Origen's publication emits inserts and
  updates for the whole database.
- **Broadcast** fans a message out in memory. On a private channel, authorization
  is checked against policies on `realtime.messages` when a client joins, and
  cached. Supabase's published p95 is 28 to 49 ms, private channels included.
- **Sending** over a kept WebSocket costs no database work per message. Each
  private send through the HTTP endpoint runs an authorization transaction on a
  one-connection pool shared by every private join, Virtual Origen's included.
  `realtime.send()` from SQL is transactional, delivered at commit, and kept three
  to four days.
- The tenant's `max_events_per_second` (default 100) counts sends **and**
  deliveries, across Virtual Origen's and SOC's traffic. Virtual Origen's
  self-hosted seed recreates the tenant at every start, so only environment
  variables change it durably.
- Neither Broadcast nor private channels have run on this stack before.

## Decision

**SOC's live traffic is Broadcast on private channels, one topic family per
organization: `org:<organization id>:soc:<stream>`. SOC never adds a table to
Virtual Origen's publication.**

- **Telemetry** (`…:soc:telemetry`): `soc-cloud` keeps one WebSocket to Realtime
  with the service role, under a supervisor that reconnects on any close, and
  sends each sample, coalesced per aircraft (latest wins) to
  `broadcast_max_rate_hz`. While the socket is down it falls back to the HTTP
  batch endpoint.
- **State changes** (`…:soc:state`): triggers on SOC's operation, flight,
  command, event and device tables call `realtime.send()` from security-definer
  functions, so a change is broadcast exactly when it commits, and never if it
  rolls back.
- **Authorization**: a permissive policy lets members of the organization named in
  the topic receive SOC topics, comparing the topic's text with
  `private.current_member_orgs()` (no cast, so a malformed topic is refused rather
  than an error). Restrictive policies keep SOC topics members-only whatever other
  policies exist, refuse them to `anon`, and refuse any client send on them; the
  service role bypasses row-level security and is the only sender.
- **History**: `soc-cloud` writes the samples of executing flights, downsampled to
  1 Hz, with one binary `COPY` per aircraft every `telemetry_batch_s` into
  `soc.telemetry_samples`.
- **Budget**: SOC's events, sends plus deliveries, stay under a quarter of the
  tenant's limit (`NFR-RES-07`). One aircraft at 5 Hz with three viewers is 20
  events per second. More aircraft need the limit raised in Virtual Origen's
  compose first (`DEP-24`).
- M1 measures all of it on the mini-PC before anything depends on it, including
  after the Realtime container is recreated.

## Alternatives considered

**Postgres changes for telemetry and state.** One path, proven on the stack. Up
to half a second of polling per message, a write and a policy check per
subscriber per sample on the farm's database, and SOC's tables in Virtual
Origen's publication.

**HTTP broadcast for every telemetry sample.** Simple, and one transaction per
sample on the pool every private join waits for.

**A WebSocket served by `soc-cloud` to browsers.** The shortest path, and a second
authentication surface, a port on the LAN and a protocol to write.

## Consequences

- The live path costs the database nothing per sample; history costs one `COPY`
  per aircraft every few seconds.
- A browser joining late gets live samples from then on; current state comes from
  the tables, a flight's track from its history.
- Losing Realtime leaves the console stale, shown as stale (`FR-TEL-02`); it never
  stops a flight, and commands do not depend on it (ADR-0006).
- `realtime.send()` reports failures only as Postgres warnings; the M1 session and
  the services' health watch for them.
