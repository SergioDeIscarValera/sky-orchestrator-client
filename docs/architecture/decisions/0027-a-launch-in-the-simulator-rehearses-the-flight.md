# ADR-0027 — A launch in the simulator rehearses the flight

- **Status**: Accepted
- **Date**: 2026-10-17

## Context

Before the first real flight (M5), the pilot wants to rehearse everything the
console does in flight, with the propellers off: the launch, pause, resume,
return home, the stop, and a takeover from the controller's sticks.

SOC already flies each file once in Sky Orchestrator's simulator: the simulated
pass (FR-OPS-06, ADR-0011). That pass is a gate, not a rehearsal:

- it is decided by how it ends: `ok` makes the operation `simulated`, anything
  else sends it back to `preparing`. A pause held too long, a stop or a takeover
  decides the gate against a file that is fine;
- the console shows it as a step of the preparation, not as a flight;
- after it, `ready` needs real mode (FR-OPS-07), so a stack in simulator mode
  never offers a launch. Every rehearsal would cost a new pass, in a new
  preparation.

Sky Orchestrator treats a simulated task as a real one: `flighttask_pause`,
`flighttask_recovery`, `return_home` and `undo` behave as in flight, and a stick
past its dead band pauses the task with `pilot_takeover` (SO's FR-FLT-11). Only
SOC stands in the way.

## Decision

**From `simulated`, in simulator mode, a pilot may launch the operation in the
simulator** (FR-OPS-13, `contracts/operations/lifecycle.json` 1.1.0).

- **The same launch.** The same confirmation, the same file, the same prepare
  with `simulate_mission.is_enable` 1, then the execute. Every blocking check
  must pass, as for the simulated pass.
- **The same flight.** The operation moves through `launching`, `in_flight`,
  `paused` and `returning` as a real flight does, so the console, its commands
  and its safety bar are the ones the real flight will use.
- **Back to `simulated` on the ground**, however the flight ended: completed,
  stopped, sent home, taken over. A refusal, or an end before take-off, is
  `simulated` again too. The operation can be rehearsed as often as wanted.
- **The record stays open and unstarted.** `started_at` is set by the launch
  from `ready` only; nothing of a rehearsal closes the operation.
- **The gate is unchanged.** The simulated pass that made the operation
  `simulated` still makes it `ready` in real mode; a rehearsal's end does not
  replace it. A stop belongs to the flight it stopped, so the real flight after
  a stopped rehearsal ends by its own outcome.
- **Fixed until it lands.** The operation comes back holding its file, so its
  wayline, geofence and fleet cannot change while a rehearsal flies, as while a
  flight is prepared.

## Alternatives considered

**Command the simulated pass.** The pass would be the rehearsal and the gate at
once: a pause or a takeover would fail the gate, and the console would need its
flight controls during a preparation step.

**A state of its own, `rehearsing`.** The existing states already describe a
flight; a parallel set would duplicate their moves, their checks and the
console's copies, and drift.

**`ready` in simulator mode.** `ready` means the real flight is next
(FR-OPS-07, NFR-SAF-05). Weakening it to offer a rehearsal weakens the one
guarantee the lifecycle exists for.

**Rehearse with Sky Orchestrator's own scripts.** It tests the phone, not SOC's
console, which is what the pilot will use.

## Consequences

- Session one rehearses the console end to end in DJI's simulator: the
  simulated pass first, then as many launches in the simulator as wanted.
- Sky Orchestrator counts each completed simulated mission for its clearance, so
  a rehearsal never harms it.
- DJI's simulator always starts at Sky Orchestrator's geofence centre, so each
  rehearsal first flies from there to the takeoff point.
- The operation's log keeps every rehearsal: each flight, its commands and its
  end reason, under the operation that flies for real later.
