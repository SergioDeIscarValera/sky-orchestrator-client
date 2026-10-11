import type { LoadedSite, SiteModel } from '../scene/siteModel'

const HASH = 'a'.repeat(64)

/** A 3 by 3 site model around Finca Norte, as soc-site bake writes one (contracts/site). */
export const MODEL: SiteModel = {
  schema_version: '1.0.0',
  origin: { latitude_deg: 41.6523, longitude_deg: -4.7245 },
  frame: 'the east-north tangent plane at the origin, WGS84 (ADR-0009, ADR-0014)',
  half_size_m: 100,
  elevation: {
    file: 'elevation.f32',
    encoding: 'float32 little-endian, rows north to south, columns west to east',
    vertices: 3,
    spacing_m: 100,
    minimum_m: 680,
    maximum_m: 700,
    at_origin_m: 690,
    sha256: HASH,
  },
  imagery: {
    file: 'imagery.png',
    encoding: '8-bit luminance, PNG, rows north to south, the hillshade baked in',
    texels: 16,
    shade_share: 0.45,
    sun: { azimuth_deg: 315, altitude_deg: 45 },
    sha256: HASH,
  },
  sources: {
    elevation: {
      url: 'https://servicios.idee.es/wcs-inspire/mdt',
      sha256: HASH,
      fetched_at: '2026-10-11T18:00:00+00:00',
      licence: 'CC BY 4.0',
    },
    imagery: {
      url: 'https://www.ign.es/wms-inspire/pnoa-ma',
      sha256: HASH,
      fetched_at: '2026-10-11T18:00:00+00:00',
      licence: 'CC BY 4.0',
    },
  },
  attribution: 'MDT05 and PNOA © Instituto Geográfico Nacional de España, CC BY 4.0 (ign.es)',
  baked_by: 'soc-site 0.1.0',
}

/** North-west 700 m to south-east 680 m, 690 m at the origin. */
export const SITE: LoadedSite = {
  model: MODEL,
  heights: Float32Array.from([700, 695, 690, 695, 690, 685, 690, 685, 680]),
  imageryUrl: '/site/test/imagery.png',
}
