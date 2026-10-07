# ADR-0009 — Geometry: generators in the web, validators in the services, golden vectors between them

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Planning is interactive: dragging a circle's radius or a grid's spacing must
redraw the preview at once, so generators run in the browser. Validation is
authoritative: before a file is built, before a flight is prepared, and on every
telemetry sample of a flight (the cloud geofence), so validators run in the
services too. Two implementations of the same geometry drift unless something
holds them together. Sky Orchestrator met the same problem between Python and
Kotlin and answered it with shared geodesy cases (`contracts/msdk/geodesy-cases.json`
there).

Measured on 2026-10-07 in a research spike (scripts in the session, figures
below):

- **Sky Orchestrator measures every limit with a spherical haversine**,
  R = 6,371,008.8 m, legs and total distance counted from the wayline's reference
  point, a value exactly at a limit passing. A true 100 m leg reads 99.73 to
  100.21 m in that metric at Spanish latitudes. Checking SO's limits with any
  other metric disagrees with SO right at the limits.
- **A local transverse Mercator (or east-north tangent plane) centred on the
  organization** is accurate to 0.007 mm on 100 m legs within 2.5 km. Python and
  V8 agree to 1.3 × 10⁻⁹ m on the closed form, so a tolerance of 10⁻⁶ m, SO's,
  passes with a thousandfold margin while bit equality does not.
- **Containment must be checked per leg with clearance.** A U-shaped polygon
  with both endpoints inside and the leg outside defeats an endpoint check.
- **Buffers cut margins.** GEOS's round buffer places arc vertices on the circle,
  so the chords between them come inside it: 4.13 m of clearance left of a 10 m
  margin at one segment per quadrant. Offsetting a convex hull with lines tangent
  to the margin circle keeps the margin exactly.
- **A concave hull of the points does not contain the legs** at any ratio tried.
- **Ordering**: an exact Held-Karp search over 13 units takes 6.3 ms in Node; above
  that, nearest neighbour then 2-opt then Or-opt came within 1.4 % of the optimum
  on average.

## Decision

- **TypeScript in `soc-web` generates**: circles, grids, the generated geofence
  and the bake. It is the only generator.
- **Python in `libs/` validates**: containment of points and legs with clearance,
  heights against the prism, the geofence inside SO's device circle, and SO's
  limits with SO's haversine and SO's semantics. A generator bug can only produce
  a wayline the validator refuses, never an unsafe one accepted.
- **One local frame**, the east-north plane of the organization's position on the
  WGS84 ellipsoid, written in closed form in both languages. SO's limits are
  checked in SO's haversine, never in the local frame.
- **Golden vectors in `contracts/geometry/`**: inputs, expected outputs and a
  tolerance of 10⁻⁶ m. SO's geodesy cases are vendored there, pinned to an SO
  commit. Both languages run every vector that applies to them in their gate.
  Vectors near a decision boundary stay at least 1 mm from it.
- **Runtime code has no geometry library.** The algorithms are small and written
  here: monotone-chain hull on robust orientation tests, tangent offset of a
  convex polygon, scanline coverage at the minimum-width angle, Held-Karp ordering
  up to 13 units and the improvement heuristics above it. pyproj, geographiclib
  and shapely are **test oracles only**: a development tool generates and checks
  the vectors with them.
- The generated geofence is the convex hull of the takeoff, the reference point
  and every waypoint, offset by the margin with tangent lines. A tighter mode
  around the path itself may come later, validated the same way.
- The bake reports violations and fixes only one thing itself: it splits legs
  longer than SO's limit, with 1 % slack.

## Alternatives considered

**One core in Rust compiled to WebAssembly and to a Python extension.** Bit
equality, irrelevant beside a 10⁻⁹ m disagreement and a GNSS error of half a metre,
for a toolchain, a build matrix and a binary in a web application meant to stay
light.

**shapely and pyproj at runtime, Turf or Clipper in the browser.** Correct, and
tens of megabytes in services with a 64 MB budget (`NFR-RES-04`); Turf mixes
numerical behaviours across modules and works on degrees directly.

**Python only, the web asking the backend for previews.** A round trip on every
slider movement, and an HTTP surface ADR-0006 rules out.

## Consequences

- A disagreement between the languages, or with SO, fails a gate the day it
  appears.
- The services stay small; the oracles live in development dependencies only.
- New geometry starts with its vectors.
