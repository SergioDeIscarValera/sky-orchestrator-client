# ADR-0025 — The preflight checks are judged from what soc-cloud records

- **Status**: Accepted
- **Date**: 2026-10-13

## Context

An operation in preparation shows its preflight checks continuously, and a check
changes state within one telemetry sample of its input crossing the threshold
(FR-OPS-04, FR-OPS-05). The inputs live in two places:

- What the stacks report reaches `soc-cloud` only:
  - each aircraft's telemetry, five times a second;
  - each stack's status;
  - each stack's envelope;
  - the dry run of a flight file.

  `soc-cloud` is the only unit that talks to Sky Orchestrator (ADR-0004).
- The operation's own data is in the database: its geofence, its wayline, its
  fleet and its pilots. Its lifecycle belongs to `soc-operations` (ADR-0006).

Telemetry already reaches the browsers over Realtime Broadcast (ADR-0007). SOC's
Realtime client sends; it does not receive (`libs/soc-realtime`).

## Decision

- **`soc-cloud` records what the stacks report, in the database**, through its
  own functions:
  - each aircraft's latest sample, as broadcast, upserted at every sample;
  - each stack's status and envelope, with when they were read, null when they
    could not be;
  - each flight's progress;
  - each dry run's verdict.

  Each function announces the change with `pg_notify` when it commits.
- **`soc-operations` judges the checks** from that record and the operation's own
  data. It wakes on those notifications, and on a timer that turns a value
  older than its threshold to unknown. It writes a check only when its state,
  value or detail changes. Each check row is broadcast to the organization's
  state topic, so the console shows exactly what will gate the next move.
- **The gate and the display are one judgement.** The simulated pass and the
  launch check the same rows the console shows. They judge again, from the
  record, at the moment of the move.

## Alternatives considered

**`soc-cloud` judges the checks in process.** It has the telemetry first, but
the checks would live in the unit that speaks DJI. That unit would need the
operation's lifecycle data, and two units would own one lifecycle.

**`soc-operations` subscribes to the telemetry topics.** Service-to-service
traffic would pass through Realtime, a best-effort channel shared with Virtual
Origen. It would need a receiving Realtime client, and no record would exist of
what a check was judged on.

**The console judges, the server checks again.** Two implementations of
sixteen checks drifting apart, and a display that could pass a check the gate
then fails.

## Consequences

- Each aircraft costs one upsert and one notification per sample, five a second.
  That is small beside the telemetry Realtime already carries; only the latest
  row is kept.
- A check is as fresh as its input. A sample's age counts from when `soc-cloud`
  received it, not from the aircraft's own timestamp. The phone's clock runs about
  half a second off the server's, so that timestamp is not a time the server can
  measure against. The checks' threshold (`telemetry_stale_after_ms`) applies to
  that age, and to the age of the stack's status and envelope reads.
- `soc.aircraft_samples` keeps the sample as broadcast
  (`contracts/broadcast/telemetry.schema.json`), so console and checks read one
  shape.
