# ADR-0014 — Units and reference frames match Sky Orchestrator

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

SOC shows heights over a terrain model, draws geofences in metres, builds files
SO validates, and reads telemetry SO publishes. Three height references exist in
that chain: above the takeoff point, above the ellipsoid, and above the terrain
under the aircraft. Sky Orchestrator accepts only heights relative to the takeoff
point (its ADR-0017), and its aircraft knows no other height reliably.

## Decision

SOC's canonical units and frames are Sky Orchestrator's:

| Quantity | Representation |
| --- | --- |
| Position | WGS84 latitude and longitude, decimal degrees |
| Height | Metres above the takeoff point, named `height_m` |
| Terrain elevation | Metres above mean sea level, from the site model, named `elevation_m`, used for display only |
| Distance | Metres |
| Speed | Metres per second |
| Heading | Degrees clockwise from true north, 0 to 360 |
| Time | UTC: Unix milliseconds on DJI's wire, `timestamptz` in the database |
| Duration | Seconds, unless the name ends in `_ms` |

- A unit is part of every name or schema that carries a physical quantity.
- Conversions live in one tested module per language, held equal by shared
  golden vectors (ADR-0009).
- The 3D view places an aircraft at the terrain elevation of its takeoff point
  plus its `height_m`. Terrain elevation never reaches SO.
- Local metric geometry uses an east-north tangent plane at the organization's
  position, which over a few kilometres is accurate to well below GPS noise.
- Distances checked against Sky Orchestrator's limits use SO's own metric, a
  spherical haversine, because that is the number SO will judge (ADR-0009).
- Headings are geodesic azimuths, never grid bearings.

## Consequences

- No height crosses a boundary without its frame in its name.
- A geofence ceiling and a wayline height mean the same thing to SOC, to SO and
  to the operator: metres above where the aircraft took off.
- Terrain following is not offered: SO refuses it, and the aircraft cannot do it
  through SO.
