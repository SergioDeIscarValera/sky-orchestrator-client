# ADR-0024 — A wayline is geometry; the operation flies it

- **Status**: Accepted
- **Date**: 2026-10-12

## Context

The first wayline designer, released in 0.4.0, saved a wayline with everything
its flight needed: the takeoff point, a default height and the drawn primitives,
and also a speed, the height climbed to over the takeoff before the transit (Sky
Orchestrator's takeoff security height), what to do at the end, and the geofence
it was designed for. Its bake split legs longer than the stack's limit, gave the
duration at that speed, and named every violation of the stack's envelope and of
that geofence.

The operator's review of 0.4.0 found that this is not how the farm works. An
operation assigns a wayline to a fleet, and its geofence holds for the whole
operation and every wayline in it. The speed is chosen when the fleet is
assigned, the climb is always the operation's own height, and a flight always
ends returning home. The same wayline is flown by different operations, with
different fleets and speeds.

The split also depended on something a wayline does not know. The stack's
envelope reaches the console only through the stack's session (Sky Orchestrator's
`GET /v1/envelope`), so a bake saved before it was known split no leg, and the
same design baked to different waypoints once it was.

## Decision

- **A wayline is geometry**: a name, a takeoff point, a default height and its
  primitives, each point or primitive with its own height if it has one. Its bake
  orders and merges them into waypoints with their distance from the takeoff, and
  depends on nothing but the design and the organization's origin.
- **The operation flies it.** It makes a flight of the bake: from the takeoff,
  climbing to the operation's height, at the assignment's speed, returning home,
  legs longer than the stack's limit split with 1 % to spare, the bake's own
  waypoints kept exactly as baked, the duration at that speed, and every
  violation of the stack's envelope and of the operation's geofence named. The
  flight is what Sky Orchestrator's mission plan and the flight file are made of.
- The design schema's major version goes to 2.0.0: `$defs.design` loses the
  speed, the climb and the finish; `$defs.baked` is the waypoints and their
  distance; `$defs.flight` is the old bake's shape, the flight file builder's
  input. A flight's `schema_version` is the design schema's; the plan sent to Sky
  Orchestrator names its own.
- This supersedes, in ADR-0009, only where legs are split: the flight splits
  them, not the bake. The rest of ADR-0009 stands: the console generates, Python
  validates, golden vectors between them.

## Alternatives considered

**Keep the speed and the climb on the wayline as defaults the operation may
override.** Two sources for one number, and an operation whose figures depend
on which wayline happened to be loaded first.

**Keep the split in the bake, baked again when the envelope arrives.** A saved
bake would change under a design that did not, which FR-WAY-09 forbids, and a
wayline flown by two stacks would need two bakes.

## Consequences

- A wayline is reused by any operation without a copy; its saved bake never
  changes once saved.
- The database drops a wayline's speed and its metrics' duration (migration
  `0009`); a wayline lists its waypoints and distance only.
- The checks against the operation's geofence and the stack's envelope run when
  the operation is planned and prepared, not while the wayline is drawn. The
  designer stops showing violations; the operation shows them.
- The flight file builder takes a flight. Its golden cases are flights, built
  byte for byte as before.
