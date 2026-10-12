import { convexHull, grownBy } from '../geometry/margin'
import type { Point } from '../geometry/planar'
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'

/** The margin a generated geofence keeps round its waylines (FR-GEO-03), as IR-GEO stores it. */
export const LEAST_MARGIN_M = 5
export const MOST_MARGIN_M = 100

/**
 * The geofence generated round `points`, the waylines' takeoff points and waypoints
 * (FR-GEO-03): their convex hull on the local frame at `origin`, grown by `marginM`
 * with at most `maxVertices` vertices. The hull holds every leg between the points, so
 * the polygon holds every point and every leg at the margin or more. None for no points.
 */
export function generatedAround(
  points: readonly Geodetic[],
  origin: Geodetic,
  marginM: number,
  maxVertices: number,
): Geodetic[] {
  if (points.length === 0) return []
  const placed = points.map((point): Point => {
    const { eastM, northM } = eastNorth(origin, point)
    return [eastM, northM]
  })
  return grownBy(convexHull(placed), marginM, maxVertices).map(([eastM, northM]) =>
    geodeticAt(origin, { eastM, northM }),
  )
}
