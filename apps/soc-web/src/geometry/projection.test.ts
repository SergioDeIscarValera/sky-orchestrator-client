// @vitest-environment node
import { readFileSync } from 'node:fs'

import { eastNorth } from './projection'

interface Point {
  readonly latitude_deg: number
  readonly longitude_deg: number
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('../../../../contracts/geometry/projection.json', import.meta.url), 'utf8'),
) as {
  readonly tolerance_m: number
  readonly cases: readonly {
    readonly name: string
    readonly origin: Point
    readonly point: Point
    readonly east_m: number
    readonly north_m: number
  }[]
}

const geodetic = ({ latitude_deg, longitude_deg }: Point) => ({
  latitudeDeg: latitude_deg,
  longitudeDeg: longitude_deg,
})

describe('the local frame (ADR-0009, ADR-0014)', () => {
  it('passes every golden vector within its tolerance, as PROJ and Python do', () => {
    expect(GOLDEN.cases.length).toBeGreaterThan(100)
    const misses = GOLDEN.cases.flatMap((golden) => {
      const placed = eastNorth(geodetic(golden.origin), geodetic(golden.point))
      const off = Math.max(
        Math.abs(placed.eastM - golden.east_m),
        Math.abs(placed.northM - golden.north_m),
      )
      return off <= GOLDEN.tolerance_m ? [] : [`${golden.name}: ${String(off)} m off`]
    })
    expect(misses).toEqual([])
  })
})
