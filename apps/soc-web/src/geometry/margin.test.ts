// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs'

import { convexHull, enlargedTo, grownBy } from './margin'
import {
  distanceToSegment,
  edges,
  legClearance,
  locate,
  problems,
  signedArea,
  type Point,
} from './planar'

/** contracts/geometry/margin.json: the generated geofences, which libs/soc-geo validates. */
const VECTORS = new URL('../../../../contracts/geometry/margin.json', import.meta.url)

interface Case {
  readonly name: string
  readonly points: readonly Point[]
  readonly margin_m: number
  readonly max_vertices: number
}

/** Seeded, so the cases are the same every run. */
function seeded(seed: number) {
  let state = seed
  return () => {
    state = (state * 16807) % 2147483647
    return state / 2147483647
  }
}

function scattered(count: number, spreadM: number, seed: number): Point[] {
  const random = seeded(seed)
  return Array.from({ length: count }, () => [
    Math.round((random() - 0.5) * spreadM * 1000) / 1000,
    Math.round((random() - 0.5) * spreadM * 1000) / 1000,
  ])
}

const CASES: readonly Case[] = [
  { name: 'one point', points: [[0, 0]], margin_m: 5, max_vertices: 32 },
  {
    name: 'a single leg',
    points: [
      [0, 0],
      [120, 40],
    ],
    margin_m: 10,
    max_vertices: 32,
  },
  {
    name: 'a square route',
    points: [
      [0, 0],
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [50, 50],
    ],
    margin_m: 5,
    max_vertices: 32,
  },
  {
    name: 'collinear points',
    points: [
      [0, 0],
      [50, 50],
      [100, 100],
    ],
    margin_m: 20,
    max_vertices: 32,
  },
  { name: 'a grid', points: scattered(60, 400, 11), margin_m: 15, max_vertices: 32 },
  { name: 'a ring of 40, few vertices', points: ring(40, 300), margin_m: 50, max_vertices: 12 },
  { name: 'wide margin', points: scattered(25, 800, 5), margin_m: 100, max_vertices: 32 },
  { name: 'the least vertices', points: scattered(30, 200, 3), margin_m: 5, max_vertices: 3 },
]

function ring(count: number, radiusM: number): Point[] {
  return Array.from({ length: count }, (_, index): Point => {
    const angle = (2 * Math.PI * index) / count
    return [
      Math.round(radiusM * Math.cos(angle) * 1000) / 1000,
      Math.round(radiusM * Math.sin(angle) * 1000) / 1000,
    ]
  })
}

function generated(input: Case): Point[] {
  return grownBy(convexHull(input.points), input.margin_m, input.max_vertices)
}

/** Every leg between the points, the hull's own edges among them. */
function legs(points: readonly Point[]): (readonly [Point, Point])[] {
  return points.flatMap((a, i) => points.slice(i + 1).map((b) => [a, b] as const))
}

describe('the geofence generated round the waylines (FR-GEO-03, ADR-0009)', () => {
  it.each(CASES)(
    '$name: simple, within its vertices, every point and leg at the margin',
    (input) => {
      const fence = generated(input)
      expect(problems(fence)).toEqual([])
      expect(signedArea(fence)).toBeGreaterThan(0)
      expect(fence.length).toBeLessThanOrEqual(input.max_vertices)
      for (const point of input.points) expect(locate(fence, point)).toBe('inside')
      const tightest = Math.min(
        ...legs(input.points).map(([a, b]) => legClearance(fence, a, b) ?? -1),
        ...input.points.map((point) => legClearance(fence, point, point) ?? -1),
      )
      expect(tightest).toBeGreaterThanOrEqual(input.margin_m - 1e-9)
    },
  )

  it('hulls counter-clockwise, its collinear and repeated points dropped', () => {
    expect(
      convexHull([
        [0, 0],
        [10, 0],
        [5, 0],
        [10, 10],
        [0, 10],
        [0, 10],
        [5, 5],
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(
      convexHull([
        [3, 3],
        [1, 1],
        [2, 2],
      ]),
    ).toEqual([
      [1, 1],
      [3, 3],
    ])
  })

  it('enlarges a hull to fewer corners without cutting it', () => {
    const hull = convexHull(ring(40, 300))
    for (const corners of [39, 30, 20, 12, 8]) {
      const fewer = enlargedTo(hull, corners)
      expect(fewer.length).toBeLessThanOrEqual(corners)
      expect(problems(fewer)).toEqual([])
      // An edge removed leaves its ends on the new edges: a computed corner rounds them
      // off it by 10⁻¹³ m, never more.
      const outside = hull
        .filter((point) => locate(fewer, point) === 'outside')
        .map((point) => Math.min(...edges(fewer).map(([a, b]) => distanceToSegment(point, a, b))))
      expect(Math.max(0, ...outside)).toBeLessThan(1e-9)
    }
  })

  it('keeps contracts/geometry/margin.json, which the Python validator checks, its output', () => {
    const written = { cases: CASES.map((input) => ({ ...input, fence: generated(input) })) }
    // WRITE_VECTORS=1 rewrites the vectors after a deliberate change to the generator.
    if (process.env.WRITE_VECTORS === '1') {
      writeFileSync(
        VECTORS,
        `${JSON.stringify(
          {
            description:
              "Geofences the console generates round its waylines (FR-GEO-03): each case's points on the local frame, its margin and most vertices, and the polygon the TypeScript generator gives. libs/soc-geo's validator holds every one to the requirement: simple, within its vertices, every point and leg between the points at the margin or more from its boundary.",
            'x-version': '1.0.0',
            ...written,
          },
          null,
          2,
        )}\n`,
      )
    }
    const kept = JSON.parse(readFileSync(VECTORS, 'utf8')) as typeof written
    expect(kept.cases).toEqual(JSON.parse(JSON.stringify(written.cases)))
  })
})
