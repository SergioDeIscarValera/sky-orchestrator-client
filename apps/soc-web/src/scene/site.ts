import type { LoadedSite } from './siteModel'

/** The ground's height above the origin's at a point of the scene, x east and z south. */
export type Ground = (x: number, z: number) => number

/** Without a site model, the flat ground: the origin's level everywhere. */
export const FLAT_GROUND: Ground = () => 0

/**
 * The scene's world is the east-north tangent plane at the organization's
 * position (ADR-0014): x east, y up, z south, in metres, the organization at
 * the origin and its ground at y = 0. This module stays free of three.js, so
 * the console can name a site without loading the 3D chunk.
 */
export interface Site {
  readonly halfSizeM: number
  /** The ground anywhere in the scene: past the site's edge, the nearest edge's height. */
  readonly ground: Ground
  /** The ground's lowest and highest points, above the origin's. */
  readonly lowestM: number
  readonly highestM: number
  /** The spacing of the ground's grid, the detail it is tested at; null where it is flat. */
  readonly spacingM: number | null
}

/** Without a baked site model the ground is a flat square this size (FR-SCN-02). */
export const FLAT_SITE: Site = {
  halfSizeM: 1000,
  ground: FLAT_GROUND,
  lowestM: 0,
  highestM: 0,
  spacingM: null,
}

/**
 * The ground's height above the origin's at a point of the site, bilinear between
 * vertices; null outside the site.
 */
export function heightAt(site: LoadedSite, east: number, north: number): number | null {
  const { half_size_m: half, elevation } = site.model
  const columns = elevation.vertices
  const column = ((east + half) / (half * 2)) * (columns - 1)
  const row = ((half - north) / (half * 2)) * (columns - 1)
  if (column < 0 || row < 0 || column > columns - 1 || row > columns - 1) return null
  const c0 = Math.min(Math.floor(column), columns - 2)
  const r0 = Math.min(Math.floor(row), columns - 2)
  const fc = column - c0
  const fr = row - r0
  const at = (r: number, c: number) => site.heights[r * columns + c] ?? elevation.at_origin_m
  const top = at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc
  const bottom = at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc
  return top * (1 - fr) + bottom * fr - elevation.at_origin_m
}

/**
 * The terrain as the scene stands on it. Past the site's edge, where nothing is
 * drawn, the nearest edge's height, so an aircraft crossing it does not jump.
 */
export function groundOf(site: LoadedSite): Ground {
  const half = site.model.half_size_m
  const clamp = (value: number) => Math.min(half, Math.max(-half, value))
  return (x, z) => heightAt(site, clamp(x), clamp(-z)) ?? 0
}

/** The scene's world for a baked site model, or the flat ground without one. */
export function siteOf(terrain: LoadedSite | null): Site {
  if (terrain === null) return FLAT_SITE
  const { half_size_m: half, elevation } = terrain.model
  return {
    halfSizeM: half,
    ground: groundOf(terrain),
    lowestM: elevation.minimum_m - elevation.at_origin_m,
    highestM: elevation.maximum_m - elevation.at_origin_m,
    spacingM: elevation.spacing_m,
  }
}
