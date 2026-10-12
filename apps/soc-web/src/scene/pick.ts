import { Vector3, type Ray } from 'three'

import type { Ground } from './site'

/** Steps along the ray small enough to find a ridge between two of the terrain's vertices. */
const STEP_M = 2
/** Halvings once the ground is crossed: a millimetre within a 2 m step after eleven. */
const HALVINGS = 24

/**
 * Where `ray` first meets the ground within `reachM` (FR-GEO-01, FR-WAY-01): marched in
 * steps until it passes below the ground, then the step halved down to the point. The
 * ground is the scene's own function, the baked terrain or the flat ground, so a point
 * drawn lands where the scene draws the ground, whatever level of detail shows. Null when
 * the ray never meets it, or starts beneath it.
 */
export function groundUnder(ray: Ray, ground: Ground, reachM: number): Vector3 | null {
  const at = (t: number) => ray.at(t, new Vector3())
  const above = (t: number) => {
    const point = at(t)
    return point.y - ground(point.x, point.z)
  }
  if (above(0) <= 0) return null
  let before = 0
  for (let t = STEP_M; t <= reachM + STEP_M; t += STEP_M) {
    const end = Math.min(t, reachM)
    if (above(end) <= 0) {
      let low = before
      let high = end
      for (let halving = 0; halving < HALVINGS; halving += 1) {
        const middle = (low + high) / 2
        if (above(middle) > 0) low = middle
        else high = middle
      }
      const found = at(high)
      return found.setY(ground(found.x, found.z))
    }
    before = end
    if (end === reachM) break
  }
  return null
}
