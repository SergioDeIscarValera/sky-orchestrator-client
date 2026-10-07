# ADR-0013 — Narrow vertical slice for the MVP

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

The full request is large: fleets with hours and incidents, reusable geofences
and waylines drawn with four interactive tools, multi-aircraft operations with
several operators, preparation checks, a simulated pass, live control, and
after-action reports with replay. The MVP's purpose is narrower and sharper: a
first real test flight commanded from SOC, showing that telemetry arrives, that
the aircraft's position updates in the 3D view, and that actions sent from the
web reach the aircraft.

## Decision

**The MVP is one complete path, at production quality:**

```
register a fleet → draw a geofence → design and bake one wayline → create an
operation (one wayline, one fleet, its operators) → prepare with live checks →
simulate the same file → launch → follow live telemetry in 3D → pause, resume,
return home → land → the operation's record kept
```

Within the path, nothing is a stub: every requirement on it has its tests, its
failure modes and its traceability row.

Outside the path, the data model reserves what later milestones need (several
assignments per operation, incidents, reports), so adding them is not a
migration of meaning. The roadmap schedules each one.

**Features may be cut from the MVP; quality may not.** The visual design, the
performance budgets and the safety behaviour of what ships are MVP requirements,
not polish for later.

## Alternatives considered

**Broad and shallow**: every panel present, most of them placeholders. Progress
becomes unmeasurable and the first real flight moves further away.

**Functional first, aesthetics later.** Rejected by the operator: a console used
to fly is judged by how clearly it shows what matters, which is design work, not
decoration.

## Consequences

- Multi-aircraft operations, waypoint actions, reports with replay, hours and
  incidents panels arrive after the first real flight, each completely.
- Telemetry history and the operation's event log are recorded from the first
  release, so reports later work on flights flown now.
