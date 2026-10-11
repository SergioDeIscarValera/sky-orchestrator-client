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
