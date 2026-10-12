// @vitest-environment node
import { readFileSync } from 'node:fs'

import { circlePoints, LEAST_CIRCLE_POINTS } from './circle'
import { eastNorth } from './projection'

interface Position {
  readonly latitude_deg: number
  readonly longitude_deg: number
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('../../../../contracts/geometry/circle.json', import.meta.url), 'utf8'),
) as {
  readonly tolerance_m: number
  readonly origin: Position
  readonly cases: readonly {
    readonly name: string
    readonly centre: Position
    readonly radius_m: number
    readonly clockwise: boolean
    readonly start_bearing_deg: number
    readonly max_arc_spacing_m: number
    readonly points: readonly Position[]
  }[]
}

const geodetic = ({ latitude_deg: latitudeDeg, longitude_deg: longitudeDeg }: Position) => ({
  latitudeDeg,
  longitudeDeg,
})
const ORIGIN = geodetic(GOLDEN.origin)

describe('the circle tool (FR-WAY-04)', () => {
  it.each(GOLDEN.cases)('$name: every point where the vectors put it', (circle) => {
    const drawn = circlePoints(
      ORIGIN,
      {
        centre: geodetic(circle.centre),
        radiusM: circle.radius_m,
        clockwise: circle.clockwise,
        startBearingDeg: circle.start_bearing_deg,
      },
      circle.max_arc_spacing_m,
    )
    expect(drawn).toHaveLength(circle.points.length)
    const off = drawn.map((point, index) => {
      const here = eastNorth(ORIGIN, point)
      const there = eastNorth(ORIGIN, geodetic(circle.points[index] ?? circle.centre))
      return Math.hypot(here.eastM - there.eastM, here.northM - there.northM)
    })
    expect(Math.max(...off)).toBeLessThan(GOLDEN.tolerance_m)
  })

  it('closes, starts at its bearing, turns its way and keeps each arc within the spacing', () => {
    const centre = { latitudeDeg: 41.6519, longitudeDeg: -4.724 }
    const at = (clockwise: boolean) =>
      circlePoints(ORIGIN, { centre, radiusM: 30, clockwise, startBearingDeg: 90 }, 10).map(
        (point) => {
          const here = eastNorth(ORIGIN, point)
          const middle = eastNorth(ORIGIN, centre)
          return [here.eastM - middle.eastM, here.northM - middle.northM] as const
        },
      )
    const clockwise = at(true)
    expect(clockwise[0]?.[0]).toBeCloseTo(30, 6)
    expect(clockwise.at(-1)?.[0]).toBeCloseTo(30, 6)
    // From east, clockwise heads south, counter-clockwise north.
    expect(clockwise[1]?.[1]).toBeLessThan(0)
    expect(at(false)[1]?.[1]).toBeGreaterThan(0)
    for (const [index, [east, north]] of clockwise.entries()) {
      expect(Math.hypot(east, north)).toBeCloseTo(30, 6)
      const next = clockwise[index + 1]
      if (next !== undefined) {
        const arc = 2 * 30 * Math.asin(Math.hypot(next[0] - east, next[1] - north) / 60)
        expect(arc).toBeLessThanOrEqual(10 + 1e-9)
      }
    }
  })

  it('is three points at least, however small', () => {
    const tiny = circlePoints(
      ORIGIN,
      { centre: ORIGIN, radiusM: 0.5, clockwise: true, startBearingDeg: 0 },
      50,
    )
    expect(tiny).toHaveLength(LEAST_CIRCLE_POINTS + 1)
  })
})
