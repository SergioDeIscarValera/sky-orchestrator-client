# ADR-0012 — Wire identity is not airframe identity

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

The operator keeps a catalogue of aircraft, called fleets: a name, the
aircraft's serial number, total flight hours, an incident history, and a model
from the DJI aircraft supported by Mobile SDK V4, from which speed, endurance and
camera capabilities follow.

On the wire, Sky Orchestrator reports a configured identity, not the airframe's:
a DJI Dock 2 (`3-2-0`) with a Matrice 3D (`0-91-0`) behind it, under serial
numbers chosen in its configuration (`SOM3DOCK0001`, `SOM3UAV00001` on the
mini-PC). The Mavic Air 2 has no Cloud API identity of its own, so SO presents
the one a client expects behind a Dock 2. No remote controller serial appears on
the wire.

## Decision

A fleet has two identities, kept apart:

- **Wire identity**: `(gateway_sn, aircraft_sn)`, as SO announces them. Unique
  among live fleets. It is how telemetry, topology and commands find the fleet.
- **Airframe identity**: the model, chosen by the operator from SOC's catalogue,
  the serial printed on the aircraft, and optionally the controller's serial.
  Specifications are read from the catalogue entry, never from the wire.

The wire's `device_model_key` and firmware are recorded with the device as seen,
and never used to infer the model.

Every flight snapshots the wire identity it flew under, so an airframe that moves
to another SO stack keeps its history: its fleet's wire identity changes, its
past flights do not.

The aircraft catalogue is reference data: a sourced JSON file in `contracts/`,
loaded by a migration, each value traceable to DJI's published specifications.

## Alternatives considered

**Inferring the model from the wire.** It would say Matrice 3D for a Mavic Air
2, with the wrong speed, endurance and camera.

**One serial number.** The wire's is configuration and the airframe's is a label;
merging them loses one of the two facts an incident report needs.

## Consequences

- Registering a fleet means pairing a device SOC has seen on the wire with an
  airframe the operator describes.
- Flight hours belong to the airframe (`IR-FLE`), summed from SOC's flights plus
  the hours it had before SOC.
- A catalogue entry with a value DJI does not publish carries `null`, never an
  estimate.
