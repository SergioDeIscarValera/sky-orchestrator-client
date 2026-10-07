# ADR-0010 — The cloud geofence is enforced where telemetry arrives

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

An operation's geofence is a polygon with one maximum height above the takeoff
point. The aircraft must not leave that prism; if it does, it returns home.

Sky Orchestrator enforces a flight envelope on the device itself (its
NFR-SAF-01): a circle around a configured centre, a ceiling, a maximum distance
from home. That is the envelope that stops the aircraft whatever any server
says. SO does not know SOC's polygon, and DJI's wire has no way to send it one.

So the polygon can only be enforced by SOC, from telemetry: the aircraft's OSD,
published by SO at its configured rate (1 Hz measured, up to 5 Hz planned).

## Decision

**`soc-cloud` checks every aircraft OSD sample of an executing flight against
that flight's geofence the moment the sample arrives**, and on the first sample
outside the polygon or above its ceiling it sends `return_home` to that aircraft,
once, and records a `geofence_breach` event of severity `SAFETY` with the
position, the distance outside and the sample's own time.

- The geofence is snapshotted into the flight when it is prepared. Editing a
  geofence never changes a flight already in the air.
- A band inside the boundary (`geofence_warning_band_m`) raises a warning event
  and takes no action.
- When telemetry goes stale the check cannot run; that is its own event, and the
  device-side envelope remains in force.
- The check is a pure function in `libs/`, shared with `soc-operations`'
  validation and held by the geometry golden vectors (ADR-0009).

## Alternatives considered

**In `soc-operations`.** Telemetry would cross Realtime to reach it and the
command would cross it back: two hops of latency and a dependency on Realtime for
a safety reaction.

**In the browser.** It would act only while someone has the page open.

**Asking SO to enforce polygons on the device.** The right long-term place, and
not on DJI's wire. Recorded as a request to SO rather than assumed.

## Consequences

- SOC acts on its own in flight, and its only action is `return_home`.
- The reaction distance is speed × (sample period + network time): at 3 m/s and
  1 Hz, about 3.5 m past the line. Generated geofences therefore keep a margin of
  at least 5 m around the route (`FR-GEO-03`).
- SO's device envelope must contain SOC's polygon, or the device trips first;
  preflight checks it (`FR-OPS-08`).
- This is defence in depth over SO's device envelope, never a replacement for it.
