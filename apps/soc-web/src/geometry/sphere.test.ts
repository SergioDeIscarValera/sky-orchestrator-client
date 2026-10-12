// @vitest-environment node
import { readFileSync } from 'node:fs'

import { distanceM, EARTH_RADIUS_M } from './sphere'

interface Position {
  readonly latitude_deg: number
  readonly longitude_deg: number
}

const CASES = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/sky-orchestrator/msdk/geodesy-cases.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly tolerance_m: number
  readonly cases: readonly {
    readonly what: string
    readonly a: Position
    readonly b: Position
    readonly distance_m: number
  }[]
}

const geodetic = ({ latitude_deg: latitudeDeg, longitude_deg: longitudeDeg }: Position) => ({
  latitudeDeg,
  longitudeDeg,
})

describe("Sky Orchestrator's metric, as its own geodesy cases (ADR-0009)", () => {
  it('is its sphere', () => {
    expect(EARTH_RADIUS_M).toBe(6_371_008.8)
  })

  it.each(CASES.cases)('$what', ({ a, b, distance_m: expected }) => {
    expect(Math.abs(distanceM(geodetic(a), geodetic(b)) - expected)).toBeLessThan(CASES.tolerance_m)
  })

  it('refuses a point that cannot be a position, never measures it', () => {
    const origin = { latitudeDeg: 0, longitudeDeg: 0 }
    for (const [latitudeDeg, longitudeDeg] of [
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
      [90.5, 0],
      [0, -181],
    ] as const) {
      expect(() => distanceM(origin, { latitudeDeg, longitudeDeg })).toThrow('out of range')
    }
  })
})
