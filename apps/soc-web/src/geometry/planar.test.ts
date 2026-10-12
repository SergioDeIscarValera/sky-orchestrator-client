// @vitest-environment node
import { readFileSync } from 'node:fs'

import {
  legClearance,
  locate,
  orientation,
  perimeter,
  problems,
  segmentsMeet,
  signedArea,
  type Place,
  type Point,
} from './planar'

interface Vectors {
  readonly tolerance_m: number
  readonly polygons: readonly {
    readonly name: string
    readonly polygon: readonly Point[]
    readonly simple: boolean
    readonly rules: readonly string[]
    readonly crossing_edges?: readonly (readonly number[])[] | null
    readonly area_m2?: number | null
    readonly perimeter_m?: number
    readonly counter_clockwise?: boolean | null
  }[]
  readonly points: readonly {
    readonly polygon: string
    readonly point: Point
    readonly place: Place
  }[]
  readonly legs: readonly {
    readonly polygon: string
    readonly from: Point
    readonly to: Point
    readonly clearance_m: number | null
  }[]
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('../../../../contracts/geometry/planar.json', import.meta.url), 'utf8'),
) as Vectors
const TOLERANCE = GOLDEN.tolerance_m
const POLYGONS = new Map(GOLDEN.polygons.map((polygon) => [polygon.name, polygon.polygon]))
const polygonOf = (name: string) => POLYGONS.get(name) ?? []

describe("the plane's predicates, as libs/soc-geo and shapely (ADR-0009)", () => {
  it.each(GOLDEN.polygons)('$name: simple or not, its edges, area and perimeter', (polygon) => {
    const found = problems(polygon.polygon)
    expect([...new Set(found.map(({ rule }) => rule))].sort()).toEqual(polygon.rules)
    if (polygon.crossing_edges != null) {
      expect(found.filter(({ rule }) => rule === 'edges_meet').map(({ edges }) => edges)).toEqual(
        polygon.crossing_edges,
      )
    }
    if (polygon.simple) {
      expect(Math.abs(Math.abs(signedArea(polygon.polygon)) - (polygon.area_m2 ?? 0))).toBeLessThan(
        TOLERANCE,
      )
      expect(signedArea(polygon.polygon) > 0).toBe(polygon.counter_clockwise)
    }
    if (polygon.perimeter_m !== undefined) {
      expect(Math.abs(perimeter(polygon.polygon) - polygon.perimeter_m)).toBeLessThan(TOLERANCE)
    }
  })

  it('locates every point inside, on or outside its polygon', () => {
    const wrong = GOLDEN.points.filter(
      ({ polygon, point, place }) => locate(polygonOf(polygon), point) !== place,
    )
    expect(wrong).toEqual([])
  })

  it('gives every leg its clearance, or none when it leaves', () => {
    const wrong = GOLDEN.legs.filter(({ polygon, from, to, clearance_m: expected }) => {
      const clearance = legClearance(polygonOf(polygon), from, to)
      if (expected === null) return clearance !== null
      return clearance === null || Math.abs(clearance - expected) >= TOLERANCE
    })
    expect(wrong).toEqual([])
  })

  it('turns counter-clockwise north of a line running east, exactly where floats round', () => {
    expect(orientation([0, 0], [1, 0], [0, 1])).toBe(1)
    expect(orientation([0, 0], [1, 0], [0, -1])).toBe(-1)
    expect(orientation([0.5, 0.5], [12, 12], [24, 24 + 2 ** -48])).toBe(1)
    expect(orientation([0.5, 0.5], [12, 12], [24, 24])).toBe(0)
  })

  it('meets a touching segment, not a parallel one', () => {
    expect(segmentsMeet([0, 0], [10, 0], [10, 0], [10, 10])).toBe(true)
    expect(segmentsMeet([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false)
  })
})
