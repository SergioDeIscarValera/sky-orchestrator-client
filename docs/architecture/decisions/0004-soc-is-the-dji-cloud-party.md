# ADR-0004 — SOC is the DJI cloud party of Sky Orchestrator

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Sky Orchestrator (SO) emulates a DJI Dock 2 over the DJI Cloud API on MQTT and
flies a consumer aircraft behind it. It ships a minimal built-in cloud so it can
fly with no client, and switches it off under `cloud_role: external` so that a
real platform takes over. SOC is that platform.

What SO offers a cloud, read from its code at v0.4.0 and confirmed by its
maintainers on 2026-10-07:

- **One credential per SO stack**, `cloud-client`, readable `thing/#` and
  `sys/#`, writable only on the topics a cloud sends on. One connection per
  credential: a second one takes the session over, and the takeover is logged.
- **One SO stack is one emulated dock with one aircraft.** Several aircraft means
  several stacks, each with its own broker, `gateway_sn` and credential.
- **Under `cloud_role: external` the cloud must** send `flighttask_prepare` with
  the file named by URL and MD5, answer `flighttask_resource_get` on
  `requests_reply` within 1.5 s, serve the same bytes at prepare and at execute
  (the dock downloads twice and compares), and send `flighttask_execute`,
  `flighttask_pause`, `flighttask_recovery`, `flighttask_undo` and
  `return_home`. Only immediate waypoint tasks are accepted.
- **Some facts are not on DJI's wire**: whether the stack flies the simulator,
  whether the operator armed the phone, the active flight envelope. SO is adding
  read-only HTTP surfaces for them (SO's FR-DEV-07, FR-WAY-11 and FR-WAY-12),
  plus a dry-run validation of a wayline file.

## Decision

**SOC integrates with SO through DJI's wire and SO's documented HTTP surfaces,
and nothing else.** Never SO's internal bus, its stores or its configuration
files.

- `soc-cloud` holds exactly one MQTT connection per configured SO stack, as
  `cloud-client`. Nothing else in SOC connects to SO's broker.
- Every message SOC publishes is validated before it leaves against SO's DJI
  schemas, vendored into `contracts/` at a pinned SO version.
- SO-specific facts (simulator mode, arming, link state, envelope, dry-run
  validation) are read over SO's HTTP surfaces by one module of `soc-cloud`, so
  the rest of SOC sees them as plain domain facts.
- A fleet is keyed by the wire identity `(gateway_sn, aircraft_sn)`; ADR-0012
  separates it from the airframe.

## Alternatives considered

**Reading SO's internal bus** (`so/internal/…`) for richer state. The broker's
ACL forbids it, and it would bind SOC to internals SO changes freely.

**Running SO with its built-in cloud and only observing.** SOC must answer the
dock's requests and serve the files it is named; the built-in cloud would answer
first and the two would disagree.

**Asking SO to extend DJI's topics with SO-specific fields.** SO forbids
extending `thing/` and `sys/` (its CON-04), and a platform that relies on
non-DJI fields on DJI topics would stop working against a real dock.

## Consequences

- At the protocol level SOC is a DJI cloud platform; the SO-specific module is
  the only part that would change against a real Dock 2.
- SOC and any other cloud client (SO's `infra/fly.py`, `infra/telemetry_check.py`)
  cannot run against the same stack at the same time.
- SOC's end-to-end suite can run against SO's published images with its fake
  bridge (SO's NFR-TEST-07), with no hardware.
- SO's refusals carry DJI's codes and little detail; the dry-run validation is
  how SOC explains a refusal before it happens.
