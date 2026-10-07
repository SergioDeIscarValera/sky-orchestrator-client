# ADR-0018 — The site model is baked once and served as static assets

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

The scene shows the farm: its terrain and its imagery, a few square kilometres
around the organization's position in Spain. The console runs on the LAN with the
internet allowed to drop (ADR-0015), on a laptop whose GPU and memory are budgeted
(`NFR-RES-03`), and the look is calm and stylised, not photographic (the design
system).

Evaluated on 2026-10-07 with test requests:

| Source | What it gives | Terms that matter |
| --- | --- | --- |
| IGN PNOA, WMS `https://www.ign.es/wms-inspire/pnoa-ma` | Orthophoto, 25 cm to 50 cm; a 2048² image of 1 km² in 4.6 s | CC BY 4.0, attribution visible |
| IGN MDT, WCS `https://servicios.idee.es/wcs-inspire/mdt` | Elevation, 5 m grid (2 m and 50 cm downloadable); 1 km² in 0.15 s | CC BY 4.0 |
| Copernicus DEM GLO-30, AWS Terrain Tiles, Mapterhorn | Global elevation fallbacks | Free with attribution |
| Esri World Imagery | Global imagery | Not to be exported for offline use |
| Mapbox | Imagery and elevation tiles | Cache only on the end user's device, 30 days; excludes uses whose failure could cause injury or damage |
| Google Photorealistic 3D Tiles | Meshes | No caching, no offline use, paid, thin rural coverage |

## Decision

**A tool bakes each organization's site model once, from IGN by default, and the
web loads it as static assets.**

- Bounds: SO's device circle or the organization's area, plus a margin.
- Elevation: IGN's MDT through WCS, sampled bilinearly onto a regular grid in the
  organization's local frame (ADR-0009), 257 × 257 vertices by default, 513 × 513
  at most.
- Imagery: IGN's PNOA through WMS, 2048 × 2048 at most, stored as luminance with
  the elevation's hillshade baked in. The scene tints it per theme in the shader,
  keeping a small share of the original (the design system).
- Output: `site.json` (origin, frame, bounds, grid, sources, dates, licences, the
  attribution text), a binary elevation grid, a compressed luminance image.
  Served by `soc-web` from a volume, recorded in `soc.site_models`.
- The attribution IGN's licence requires is shown at the foot of the scene.
- A site that cannot be baked falls back to a flat ground with a grid, said so on
  screen (`FR-SCN-02`).
- Re-baking is deliberate; the same inputs produce the same assets (`FR-DEP-05`).

## Alternatives considered

**Streaming tiles while the console runs.** Up-to-date imagery for any place, at
the price of the internet on the console's path, provider terms that forbid
serving cached tiles from the mini-PC, and per-frame tile management on the GPU.

**Google's photorealistic meshes.** Striking where they exist, paid, uncacheable,
online only, and the opposite of the calm scene the design asks for.

**A flat map with no terrain.** Lightest, and wrong wherever the farm is not flat:
heights above takeoff only mean something drawn over the real ground.

## Consequences

- The scene works with no internet and costs a bounded, known amount of memory:
  about 3.5 MiB of mesh and 5.3 MiB of single-channel texture with mipmaps at the
  defaults.
- Imagery is as old as the last bake and IGN's last flight over the area; the site
  records both dates.
- The baking tool needs the internet once, run by hand on the mini-PC.
