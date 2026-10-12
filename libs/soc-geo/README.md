# soc-geo

SOC's geometry in closed form, and Newton's method where a closed form does
not exist, without a geometry library at run time
([ADR-0009](../../docs/architecture/decisions/0009-geometry-generators-validators-and-golden-vectors.md)).

## What it holds today

- **The one local frame** (`soc_geo.projection`): the east-north tangent
  plane at the organization's position on the WGS84 ellipsoid (ADR-0014),
  `east_north` in closed form and its inverse `geodetic_at` by Newton's method.
  The console's scene, `soc-site`'s bake, the console end to end's dock and,
  from M3, the validators place every point through it.
- **Sky Orchestrator's metric** (`soc_geo.sphere`): the haversine on a sphere
  of 6,371,008.8 m, as SO checks every limit of a flight. SOC measures SO's
  limits in it, and only those, so a wayline is refused here exactly where SO
  would refuse it. A position that is NaN, infinite or out of range is refused,
  never measured: NaN compares false against every limit, so it would pass them.
- **The plane's predicates** (`soc_geo.planar`), on the local frame: the turn of
  three points, decided exactly (a float filter, then the exact rational
  determinant where the filter cannot be sure, so no rounding flips a decision at
  a boundary); whether segments meet; why a polygon is not simple (too few
  vertices, an edge of no length, edges that meet, no area), naming its edges; a
  point inside, on or outside; area and perimeter; a leg's clearance from the
  boundary, or none when any of it is on or outside it, every edge tried against
  the leg itself, since a leg across the arms of a U leaves with both ends in.

- **Sky Orchestrator's envelope** (`soc_geo.limits`): the limits so-wayline
  judges a flight file by (its envelope.py), checked in its order, in its metric,
  a value exactly at a limit passing, each violation under Sky Orchestrator's own
  code with its waypoint: too many waypoints, the takeoff security height or a
  waypoint above the ceiling, a point outside the geofence's circle, a leg too
  long, the route too long, a speed above the limit, and given the takeoff
  position, the transit and the distance from home. The console's bake reports
  the same violations with the same codes (`src/geometry/limits.ts`).

## What the console generates, checked here

The console's TypeScript is the only generator (ADR-0009); its outputs are kept
in `contracts/geometry/` and this package checks each independently, so a
generator bug can only make an output the validator refuses:

- `circle.json`: the circle tool's points, from the same closed form here, every
  one at the radius within 0.1 m and no arc beyond the spacing by pyproj's
  geodesic (`tests/circle_oracle.py`).
- `margin.json`: the geofences grown round waylines: simple, within their
  vertices, every point and every leg between the points at the margin or more.
- `grid.json`: the grid tool's coverages: every point inside the area, the lines
  parallel at the spacing within 0.1 m, none fewer at any bearing of a half-degree
  sweep.
- `bake.json`: designs and their bakes: the schema followed, the violations
  exactly what `soc_geo.limits` finds, the distance in Sky Orchestrator's metric,
  no leg beyond the envelope unless reported, no two points within half a metre;
  a bake with no waypoint refused by the schema.

## Golden vectors

`contracts/geometry/projection.json` holds 125 cases: at the farm, the equator,
high latitude, the southern hemisphere and across the antimeridian, from 1 m to
2.5 km in six directions, each with what PROJ says, within 10⁻⁶ m. This package
and the console's `src/geometry/projection.ts` pass every case in their gates.

PROJ (through pyproj, a development dependency) is the oracle and never runs in
a service. `tests/oracle.py` writes the file; a test regenerates it and fails
when it no longer matches:

```bash
uv run python libs/soc-geo/tests/oracle.py > contracts/geometry/projection.json
uv run --frozen pytest libs/soc-geo/tests
```

`contracts/geometry/planar.json` holds 9 polygons, 96 points and 66 legs, from
shapely through `tests/planar_oracle.py` the same way: a square, a clockwise
triangle, a U and a farm of 32 vertices; a bow-tie, a spike doubling back,
collinear vertices, a vertex repeated and two vertices. Points and legs near a
decision keep at least 1 mm from it, so the tolerance never decides a vector.

```bash
uv run python libs/soc-geo/tests/planar_oracle.py > contracts/geometry/planar.json
```

Sky Orchestrator's own geodesy cases, vendored at its v0.4.2
(`contracts/sky-orchestrator/msdk/geodesy-cases.json`), hold `soc_geo.sphere`
within 10⁻⁶ m.

## The design schema

`contracts/geometry/design.schema.json` (1.0.0) is a wayline as the console's
designer saves it and as its bake leaves it: the takeoff point, the default
height, the takeoff security height, the speed, the finish, and the drawn
primitives (routes, points, circles, grids), each point with its own height if
it has one; then the baked waypoints, their distance in SO's metric, duration and
violations. Positions are stored in GeoJSON order, `[longitude, latitude]`, and
polygons as rings of them, not closed, as the units table says; DJI's order is
written in one place only, the flight file builder. The bake carries what Sky
Orchestrator's mission plan needs: a test turns the example's bake into SO's form,
as the builder will, and holds it, with an identity and a fingerprint, to SO's
vendored `mission-plan.schema.json`. `contracts/geometry/examples/` holds a route
and its bake, and a circle and a grid not baked yet.
