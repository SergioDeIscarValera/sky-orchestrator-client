/**
 * The scene's world is the east-north tangent plane at the organization's
 * position (ADR-0014): x east, y up, z south, in metres, the organization at
 * the origin and the ground at y = 0. This module stays free of three.js, so
 * the console can name a site without loading the 3D chunk.
 */
export interface Site {
  readonly halfSizeM: number
}

/** Without a baked site model the ground is a flat square this size (FR-SCN-02). */
export const FLAT_SITE: Site = { halfSizeM: 1000 }
