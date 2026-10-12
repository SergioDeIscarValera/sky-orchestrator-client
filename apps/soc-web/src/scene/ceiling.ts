import { draped, type Flat } from './drape'
import type { Ground } from './site'

/**
 * The walls of a geofence's volume (FR-GEO-01): from the ground, lifted `liftM`, up to its
 * ceiling, along its ring cut every `stepM` as its outline is, as triangles for a mesh.
 * The ceiling is drawn over the ground beneath each point: on the MVP's flat ground that is
 * the takeoff point's level the ceiling is measured from (ADR-0014).
 */
export function ceilingWalls(
  ring: readonly Flat[],
  ground: Ground,
  stepM: number,
  liftM: number,
  ceilingM: number,
): Float32Array {
  if (ring.length < 3 || !(ceilingM > liftM)) return new Float32Array()
  const bottom = draped(ring, ground, stepM, liftM, true)
  const top = draped(ring, ground, stepM, ceilingM, true)
  const triangles: number[] = []
  for (let index = 0; index + 1 < bottom.length; index += 1) {
    const [b0, b1, t0, t1] = [bottom[index], bottom[index + 1], top[index], top[index + 1]]
    if (b0 === undefined || b1 === undefined || t0 === undefined || t1 === undefined) continue
    triangles.push(...b0, ...b1, ...t1, ...b0, ...t1, ...t0)
  }
  return new Float32Array(triangles)
}
