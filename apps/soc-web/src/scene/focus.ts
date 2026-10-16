import type { SceneBox, ScenePoint } from './commands'

/**
 * The least box that holds every point, from its least corner to its greatest, or null with no point to
 * hold: what an operation in focus is framed within (FR-SCN-05).
 */
export function boundingBox(points: readonly ScenePoint[]): SceneBox | null {
  if (points.length === 0) return null
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const { x, y, z } of points) {
    min.x = Math.min(min.x, x)
    min.y = Math.min(min.y, y)
    min.z = Math.min(min.z, z)
    max.x = Math.max(max.x, x)
    max.y = Math.max(max.y, y)
    max.z = Math.max(max.z, z)
  }
  return { min, max }
}
