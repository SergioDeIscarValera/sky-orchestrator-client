import type { Ground } from './site'

/** A point on the ground plane of the scene: x east, z south, in metres. */
export interface Flat {
  readonly x: number
  readonly z: number
}

/**
 * A line laid over the ground through `points` (FR-GEO-01): each edge cut every
 * `stepM`, so it follows the terrain between its vertices, and lifted `liftM` above
 * it. Closed, it comes back to the first point. On the flat ground nothing needs
 * cutting: pass Infinity.
 */
export function draped(
  points: readonly Flat[],
  ground: Ground,
  stepM: number,
  liftM: number,
  closed: boolean,
): [number, number, number][] {
  const on = (x: number, z: number): [number, number, number] => [x, ground(x, z) + liftM, z]
  const line: [number, number, number][] = []
  const ends = closed && points.length > 2 ? [...points, points[0]] : points
  for (let index = 0; index + 1 < ends.length; index += 1) {
    const from = ends[index]
    const to = ends[index + 1]
    if (from === undefined || to === undefined) continue
    const cuts = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / stepM))
    for (let cut = 0; cut < cuts; cut += 1) {
      const share = cut / cuts
      line.push(on(from.x + (to.x - from.x) * share, from.z + (to.z - from.z) * share))
    }
  }
  const last = ends.at(-1)
  if (last !== undefined) line.push(on(last.x, last.z))
  return line
}
