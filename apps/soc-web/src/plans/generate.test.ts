// @vitest-environment node
import { distanceToSegment, locate, type Point } from '../geometry/planar'
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import { generatedAround } from './generate'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })
const placed = (point: Geodetic): Point => {
  const { eastM, northM } = eastNorth(FARM, point)
  return [eastM, northM]
}

/** Two waylines' takeoff points and waypoints: a route north and a loop to the east. */
const POINTS = [
  at(0, 0),
  at(0, 120),
  at(30, 240),
  at(10, 0),
  at(200, 40),
  at(260, 90),
  at(220, 150),
]

function clearance(polygon: readonly Point[], point: Point): number {
  return Math.min(
    ...polygon.map((start, index) => {
      const end = polygon[(index + 1) % polygon.length] ?? start
      return distanceToSegment(point, start, end)
    }),
  )
}

describe('a geofence generated round the waylines (FR-GEO-03)', () => {
  it.each([5, 20, 100])('holds every point and leg at a %d m margin or more', (marginM) => {
    const polygon = generatedAround(POINTS, FARM, marginM, 32).map(placed)
    expect(polygon.length).toBeLessThanOrEqual(32)
    for (const point of POINTS.map(placed)) {
      expect(locate(polygon, point)).toBe('inside')
      expect(clearance(polygon, point)).toBeGreaterThanOrEqual(marginM - 1e-6)
    }
    // Every leg between two points lies in their hull, so at the margin too: its middle.
    for (const [index, from] of POINTS.entries()) {
      const to = POINTS[(index + 1) % POINTS.length] ?? from
      const [a, b] = [placed(from), placed(to)]
      const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      expect(clearance(polygon, middle)).toBeGreaterThanOrEqual(marginM - 1e-6)
    }
  })

  it('stays within the vertex bound however tight', () => {
    expect(generatedAround(POINTS, FARM, 20, 8).length).toBeLessThanOrEqual(8)
  })

  it('rings a single point, and is nothing for none', () => {
    const ring = generatedAround([at(50, 50)], FARM, 10, 16).map(placed)
    expect(ring.length).toBeGreaterThanOrEqual(3)
    expect(clearance(ring, [50, 50])).toBeGreaterThanOrEqual(10 - 1e-6)
    expect(generatedAround([], FARM, 10, 16)).toEqual([])
  })
})
