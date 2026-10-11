import { z } from '../schema'

/**
 * `site.json` as `soc-site bake` writes it (`contracts/site/site.schema.json` 1.0.0,
 * ADR-0018); a test holds this mirror equal to the contract. Three-free, so the
 * console can load a site before the 3D chunk.
 */
const SHA256 = z.string().check(z.regex(/^[0-9a-f]{64}$/))
const SOURCE = z.strictObject({
  url: z.string().check(z.regex(/^https:\/\//)),
  sha256: SHA256,
  fetched_at: z.string(),
  licence: z.string().check(z.minLength(1)),
})

export const SITE_MODEL = z.strictObject({
  schema_version: z.string().check(z.regex(/^1\.[0-9]+\.[0-9]+$/)),
  origin: z.strictObject({
    latitude_deg: z.number().check(z.gte(-90), z.lte(90)),
    longitude_deg: z.number().check(z.gte(-180), z.lte(180)),
  }),
  frame: z.string(),
  half_size_m: z.number().check(z.gt(0), z.lte(5000)),
  elevation: z.strictObject({
    file: z.literal('elevation.f32'),
    encoding: z.string(),
    vertices: z.int().check(z.gte(3), z.lte(513)),
    spacing_m: z.number().check(z.gt(0)),
    minimum_m: z.number(),
    maximum_m: z.number(),
    at_origin_m: z.number(),
    sha256: SHA256,
  }),
  imagery: z.strictObject({
    file: z.literal('imagery.png'),
    encoding: z.string(),
    texels: z.int().check(z.gte(16), z.lte(2048)),
    shade_share: z.number().check(z.gte(0), z.lte(1)),
    sun: z.strictObject({
      azimuth_deg: z.number().check(z.gte(0), z.lte(360)),
      altitude_deg: z.number().check(z.gte(0), z.lte(90)),
    }),
    sha256: SHA256,
  }),
  sources: z.strictObject({ elevation: SOURCE, imagery: SOURCE }),
  attribution: z.string().check(z.minLength(1)),
  baked_by: z.string(),
})

export type SiteModel = z.infer<typeof SITE_MODEL>

/** A site model ready to draw: its description, its heights, and where its imagery is. */
export interface LoadedSite {
  readonly model: SiteModel
  /** Above mean sea level, rows from north to south, columns from west to east. */
  readonly heights: Float32Array
  readonly imageryUrl: string
}

export class SiteModelError extends Error {}

/** Where an organization's site model is served (ADR-0018). */
export function siteBase(organizationId: string): string {
  return `/site/${encodeURIComponent(organizationId)}/`
}

/**
 * The organization's site model, or null when it has none (a 404): the scene then
 * keeps its flat ground (FR-SCN-02). A model that does not follow the contract, or
 * whose heights are not the grid it declares, is an error, never a flat ground.
 */
export async function loadSite(
  organizationId: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadedSite | null> {
  const base = siteBase(organizationId)
  const answer = await fetcher(`${base}site.json`, { cache: 'no-cache' })
  if (answer.status === 404) return null
  if (!answer.ok)
    throw new SiteModelError(`${base}site.json answered HTTP ${String(answer.status)}`)
  const parsed = SITE_MODEL.safeParse(await answer.json().catch(() => null))
  if (!parsed.success) throw new SiteModelError(`${base}site.json does not follow its contract`)
  const model = parsed.data
  const grid = await fetcher(`${base}${model.elevation.file}`, { cache: 'no-cache' })
  if (!grid.ok)
    throw new SiteModelError(`${base}${model.elevation.file} answered HTTP ${String(grid.status)}`)
  const bytes = await grid.arrayBuffer()
  const expected = model.elevation.vertices ** 2 * 4
  if (bytes.byteLength !== expected) {
    throw new SiteModelError(
      `${model.elevation.file} holds ${String(bytes.byteLength)} bytes, not the ${String(expected)} of its grid`,
    )
  }
  const view = new DataView(bytes)
  const heights = new Float32Array(model.elevation.vertices ** 2)
  for (let index = 0; index < heights.length; index += 1) {
    heights[index] = view.getFloat32(index * 4, true)
  }
  return { model, heights, imageryUrl: `${base}${model.imagery.file}` }
}
