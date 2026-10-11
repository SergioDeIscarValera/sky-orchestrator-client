# soc-site

Bakes an organization's site model once: its terrain and its imagery, from IGN,
into the assets the console loads (ADR-0018, `FR-DEP-05`). Copied into the
compose project's `site/<organization>/`, the model is served read-only by
`soc-web` at `/site/<organization>/`; how is in [infra](../README.md).

```bash
uv run soc-site fetch --latitude 41.6523 --longitude -4.7245 --half-size-m 1000 --sources site/sources
uv run soc-site bake --sources site/sources --out site/model
```

## The two halves

- **`fetch`** is the only part that needs the internet. It works out the degrees
  that enclose the site's square on the organization's local frame (ADR-0009),
  plus a margin. It asks IGN for the 5 m MDT over them (WCS, `Elevacion4258_5`,
  ArcGrid) and for PNOA's orthophoto at 2048 × 2048 (WMS, `OI.OrthoimageCoverage`,
  JPEG). It writes the answers as they came, with each one's SHA-256, URL, fetch
  time and licence, into `sources.json`.
- **`bake`** works from those files alone and refuses a file whose SHA-256 has
  changed. It lays both sources on the local frame and writes three files:
  - `elevation.f32`: 257 × 257 heights by default, 513 at most, float32
    little-endian, rows from north to south.
  - `imagery.png`: 2048 × 2048 luminance with the terrain's hillshade baked in,
    lit from the north-west at 45°. The scene tints it per theme.
  - `site.json`: the frame, the grids and their hashes, the sources and the
    attribution, following [`contracts/site/site.schema.json`](../../contracts/site/site.schema.json).

  The same sources bake the same bytes. A site over `NFR-PERF-05`'s 8 MB is refused.

## Measured on 2026-10-11

Finca Norte's demo position, a 2 km square in the centre of Valladolid:

| Step | Time | Output |
| --- | --- | --- |
| fetch | 6.5 s | 1.8 MB of ArcGrid, 1.3 MB of JPEG |
| bake | 22 s | heights from 677.0 m to 698.9 m; 264 KB of elevation, 2.8 MB of imagery |

Two bakes of the same sources gave identical bytes.

## What to know

- ETRS89, IGN's datum, is read as WGS84. The two differ by under a metre in 2026,
  below the MDT's 5 m grid.
- The attribution IGN's CC BY 4.0 licence requires is in `site.json`, for the
  console to show at the foot of the scene.
- The array forms of the local frame and its inverse are `soc_geo`'s closed form
  and its Newton inverse over numpy arrays. A test holds them equal to `soc_geo`
  on random points within 2.5 km.
