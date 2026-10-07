# ADR-0008 — Flight files are built by SOC, kept as bytes and served on SO's network

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Under `cloud_role: external`, Sky Orchestrator's dock downloads the wayline file
(a KMZ) from the URL named in `flighttask_prepare`, again when it asks
`flighttask_resource_get` at execute, and cancels the task if the bytes differ.
Its download rules: `http` or `https`, no redirect, at most `max_kmz_bytes`, a
5 s timeout. The answer to `flighttask_resource_get` is due within 1.5 s. The
service that downloads, `so-wayline`, runs on SO's compose network
`sky-orchestrator_default`, which SO recommends SOC's backend joins, as SO's own
test cloud does.

Supabase Storage is enabled on the mini-PC but nothing exercises it, and a
signed URL would be fetched across networks through the host.

A KMZ for this aircraft is a few kilobytes: at most a few hundred waypoints in
the subset SO accepts.

## Decision

- `soc-operations` builds the KMZ from the wayline, deterministically: the same
  wayline and parameters give the same bytes, with fixed archive timestamps and
  ordering. The WPML it writes is the subset SO accepts, pinned in `contracts/`.
- The exact bytes, their MD5 and size are stored in `soc.flight_files`, next to
  the flight that used them. They are never rebuilt for the same flight.
- `soc-cloud` serves them over HTTP on SO's network only, at an unguessable path
  (`/files/<random token>.kmz`), with no port published to the host or the LAN.
- `soc-cloud` answers `flighttask_resource_get` from memory, keyed by flight, so
  the 1.5 s deadline does not depend on the database.

## Alternatives considered

**Supabase Storage with signed URLs.** No new server, but an unexercised
component, a URL that leaves SO's network and comes back through the host, and an
expiry that must outlast the second download at execute.

**SO's own wayline catalogue.** That is the built-in cloud's role, switched off
under `external`.

## Consequences

- The bytes that flew are kept with the flight: an investigation reads exactly
  what the dock was given.
- A golden file per reference wayline pins the builder; SO's dry-run validation
  (SO's FR-WAY-12) confirms SO accepts it.
- `soc-cloud` carries a small HTTP server; its health check covers it.
- File rows are retained with their flight records (`IR-FIL`), small by
  construction.
