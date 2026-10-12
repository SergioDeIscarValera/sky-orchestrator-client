// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs'

import { cover, fewestLinesAngle, linesFor, type Grid } from './grid'
import { locate, type Point } from './planar'

/** contracts/geometry/grid.json: the coverages, which libs/soc-geo checks independently. */
const VECTORS = new URL('../../../../contracts/geometry/grid.json', import.meta.url)

interface Case {
  readonly name: string
  readonly area: readonly Point[]
  readonly line_spacing_m: number
  readonly point_spacing_m: number
  readonly angle_deg?: number
}

const CASES: readonly Case[] = [
  {
    name: 'a field square to the north',
    area: [
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ],
    line_spacing_m: 20,
    point_spacing_m: 25,
  },
  {
    name: 'a long field across the bearings',
    area: [
      [0, 0],
      [300, 300],
      [280, 320],
      [-20, 20],
    ],
    line_spacing_m: 10,
    point_spacing_m: 15,
  },
  {
    name: 'an L, lines across its arms',
    area: [
      [0, 0],
      [120, 0],
      [120, 40],
      [40, 40],
      [40, 160],
      [0, 160],
    ],
    line_spacing_m: 12,
    point_spacing_m: 20,
  },
  {
    name: 'an angle given',
    area: [
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ],
    line_spacing_m: 20,
    point_spacing_m: 25,
    angle_deg: 45,
  },
  {
    name: 'narrower than a spacing',
    area: [
      [0, 0],
      [100, 0],
      [100, 6],
      [0, 6],
    ],
    line_spacing_m: 20,
    point_spacing_m: 30,
  },
]

const gridOf = (input: Case): Grid => ({
  area: input.area,
  lineSpacingM: input.line_spacing_m,
  pointSpacingM: input.point_spacing_m,
  ...(input.angle_deg === undefined ? {} : { angleDeg: input.angle_deg }),
})

describe('the grid tool (FR-WAY-05)', () => {
  it.each(CASES)('$name: every point inside, lines parallel at the spacing', (input) => {
    const { angleDeg, lines } = cover(gridOf(input))
    expect(lines.length).toBeGreaterThan(0)
    for (const point of lines.flat()) expect(locate(input.area, point)).toBe('inside')
    const across: Point = [
      Math.cos((angleDeg * Math.PI) / 180),
      -Math.sin((angleDeg * Math.PI) / 180),
    ]
    const offsets = lines.map((line) => line.map((p) => p[0] * across[0] + p[1] * across[1]))
    for (const line of offsets) {
      expect(Math.max(...line) - Math.min(...line)).toBeLessThan(1e-6)
    }
    const firsts = offsets.map((line) => line[0] ?? 0)
    for (const [index, offset] of firsts.slice(1).entries()) {
      const gap = offset - (firsts[index] ?? 0)
      // Lines skipped where the area has a hole across them are whole spacings apart.
      const spacings = gap / input.line_spacing_m
      expect(Math.abs(spacings - Math.round(spacings)) * input.line_spacing_m).toBeLessThan(0.1)
    }
  })

  it('flies each line back the other way from the last', () => {
    const { angleDeg, lines } = cover(gridOf(CASES[0] as Case))
    expect(angleDeg).toBe(90)
    const runs = lines.map((line) => (line.at(-1)?.[0] ?? 0) - (line[0]?.[0] ?? 0))
    for (const [index, run] of runs.entries()) expect(Math.sign(run)).toBe(index % 2 === 0 ? 1 : -1)
  })

  it('chooses the bearing that needs the fewest lines', () => {
    const area: Point[] = [
      [0, 0],
      [300, 300],
      [280, 320],
      [-20, 20],
    ]
    const chosen = fewestLinesAngle(area, 10)
    const across = (deg: number) => {
      const a = (deg * Math.PI) / 180
      const offsets = area.map((p) => p[0] * Math.cos(a) - p[1] * Math.sin(a))
      return linesFor(Math.max(...offsets) - Math.min(...offsets), 10)
    }
    for (let degrees = 0; degrees < 180; degrees += 0.5) {
      expect(across(chosen)).toBeLessThanOrEqual(across(degrees))
    }
  })

  it('keeps contracts/geometry/grid.json, which libs/soc-geo checks, its output', () => {
    const written = {
      cases: CASES.map((input) => ({ ...input, coverage: cover(gridOf(input)) })),
    }
    if (process.env.WRITE_VECTORS === '1') {
      writeFileSync(
        VECTORS,
        `${JSON.stringify(
          {
            description:
              "The grid tool's coverages (FR-WAY-05): each case's area on the local frame, its spacings and angle if given, and the lines the TypeScript generator flies. libs/soc-geo holds every one to the requirement: every point inside the area, the lines parallel at the spacing within 0.1 m, and none fewer at any other bearing unless one was given.",
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
