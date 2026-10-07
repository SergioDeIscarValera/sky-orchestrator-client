# ADR-0011 — Simulate, then fly the same file

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

The operator's requirement: launching an operation first runs a battery of
checks and a simulated flight; only when the simulation has finished does the
operation become ready, and only then can it be launched for real.

Sky Orchestrator's facts, from its maintainers on 2026-10-07:

- The MSDK V4 simulator starts and stops only on the ground with the motors off,
  so SO cannot simulate one task and fly the next.
- Real flight is a property of the SO deployment behind two keys (SO's
  NFR-SAF-03): a server setting and a confirmation on the phone. A lost flag can
  never fly for real.
- SO is adding, in its ADR-0037: a prepare must carry `simulate_mission.is_enable`
  equal to the deployment's mode, in both directions (SO's FR-FLT-11), and a real
  prepare is refused for any file, by MD5, this deployment has not flown to `ok`
  in simulator mode (SO's NFR-SAF-07).
- SO reports its mode to a client over HTTP (SO's FR-DEV-07), `null` when
  unknown.

## Decision

**An operation reaches `ready` only after a simulated flight of the exact flight
file it will fly ended `ok`**, and the real flight prepares the same bytes.

- `soc-operations` sets `simulate_mission.is_enable` from SO's reported mode and
  refuses to prepare while that mode is unknown.
- Every flight records the mode SO reported when it was prepared. SOC never
  infers it.
- Any change to the wayline, the geofence or the flight parameters produces a new
  file, a new MD5, and puts the operation back before its simulation.
- Between the simulation and the launch, the operator turns SO's two keys. SOC
  shows the step and checks it through SO's mode; it cannot perform it.

## Alternatives considered

**A kinematic simulation in SOC.** Useful as a preview of time and battery, and
planned as such, but it exercises neither the aircraft, the application nor SO.
It does not replace this gate.

**No simulated pass.** Against the operator's requirement and against SO's own
gate, which would refuse the real prepare anyway.

## Consequences

- A real flight is always preceded, in the record, by a successful simulation of
  the same bytes, checked twice: by SOC's lifecycle and by SO's guard.
- The simulated pass costs the duration of the mission at the simulator's pace.
- Switching SO's mode is a deliberate human step in the middle of the flow, by
  design.
