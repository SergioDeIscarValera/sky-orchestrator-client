// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs'

import { bake, MERGE_M, SPLIT_SLACK } from './bake'
import { bakedToJson, designFromJson, envelopeFromSkyOrchestrator } from './designJson'
import { eastNorth, type Geodetic } from './projection'
import { distanceM } from './sphere'

/** contracts/geometry/bake.json: designs and their bakes, which libs/soc-geo checks. */
const VECTORS = new URL('../../../../contracts/geometry/bake.json', import.meta.url)
const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

/** A position `east` and `north` metres from the farm, as a design would hold it. */
function near(east: number, north: number): [number, number] {
  return [FARM.longitudeDeg + east / 83_330, FARM.latitudeDeg + north / 111_045]
}

/** A drawn point there, with its own height when given. */
function at(east: number, north: number, heightM?: number) {
  return { position: near(east, north), ...(heightM === undefined ? {} : { height_m: heightM }) }
}

const ROOMY = {
  geofence_center: { latitude_deg: FARM.latitudeDeg, longitude_deg: FARM.longitudeDeg },
  geofence_radius_m: 1000,
  max_height_m: 120,
  max_home_distance_m: 1000,
  max_leg_m: 300,
  max_transit_m: 300,
  max_total_distance_m: 5000,
  max_waypoints: 200,
  max_horizontal_speed_ms: 15,
}

const BASE = {
  schema_version: '1.0.0',
  takeoff: near(0, 0),
  default_height_m: 30,
  takeoff_security_height_m: 20,
  speed_ms: 5,
  finish_action: 'return_home',
}

type Json = Record<string, unknown>

const CASES: readonly { name: string; design: Json; envelope: Json }[] = [
  {
    name: 'a route and a point of interest',
    design: {
      ...BASE,
      primitives: [
        { kind: 'route', points: [at(0, 28), at(37, 28), at(37, 0, 35)] },
        { kind: 'points', points: [at(17, 0)] },
      ],
    },
    envelope: ROOMY,
  },
  {
    name: 'twenty points of interest, ordered by the heuristic',
    design: {
      ...BASE,
      primitives: [
        {
          kind: 'points',
          points: Array.from({ length: 20 }, (_, i) =>
            at(((i * 37) % 200) - 100, ((i * 53) % 160) - 80),
          ),
        },
      ],
    },
    envelope: ROOMY,
  },
  {
    name: 'a route, a circle and a grid, ordered exactly',
    design: {
      ...BASE,
      primitives: [
        {
          kind: 'grid',
          area: [near(100, 100), near(160, 100), near(160, 140), near(100, 140)],
          line_spacing_m: 10,
          point_spacing_m: 15,
          height_m: 25,
        },
        {
          kind: 'circle',
          centre: near(-80, 60),
          radius_m: 30,
          clockwise: true,
          start_bearing_deg: 0,
        },
        { kind: 'route', points: [at(20, -40), at(60, -40)] },
      ],
    },
    envelope: ROOMY,
  },
  {
    name: 'legs longer than the stack allows, split',
    design: { ...BASE, primitives: [{ kind: 'route', points: [at(0, 100), at(250, 100)] }] },
    envelope: { ...ROOMY, max_leg_m: 60 },
  },
  {
    name: 'a point above the ceiling, reported not fixed',
    design: {
      ...BASE,
      primitives: [{ kind: 'route', points: [at(0, 50), at(50, 50, 150)] }],
    },
    envelope: ROOMY,
  },
  {
    name: 'points closer than half a metre, merged',
    design: {
      ...BASE,
      primitives: [{ kind: 'route', points: [at(10, 10), at(10.3, 10), at(40, 10)] }],
    },
    envelope: ROOMY,
  },
  { name: 'nothing drawn', design: { ...BASE, primitives: [] }, envelope: ROOMY },
]

const baked = (input: (typeof CASES)[number]) =>
  bake(designFromJson(input.design), {
    origin: FARM,
    maxArcSpacingM: 10,
    envelope: envelopeFromSkyOrchestrator(input.envelope),
  })

const local = (point: Geodetic) => {
  const placed = eastNorth(FARM, point)
  return [placed.eastM, placed.northM] as const
}

describe('the bake (FR-WAY-07)', () => {
  it('bakes the same design to the same wayline, every time', () => {
    for (const input of CASES) expect(baked(input)).toEqual(baked(input))
  })

  it('flies a route in the order drawn and every point of interest once', () => {
    const input = CASES[0] as (typeof CASES)[number]
    const { waypoints, violations } = baked(input)
    expect(violations).toEqual([])
    const where = waypoints.map(local)
    const [route, poi] = designFromJson(input.design).primitives
    const indexOf = (point: Geodetic) => {
      const [east, north] = local(point)
      return where.findIndex((w) => Math.hypot(w[0] - east, w[1] - north) < 1e-6)
    }
    const found = route?.kind === 'route' ? route.points.map(indexOf) : []
    expect(found).toHaveLength(3)
    expect(found.every((index) => index >= 0)).toBe(true)
    expect([...found].sort((a, b) => a - b)).toEqual(found)
    expect(waypoints.find((w) => w.heightM === 35)).toBeDefined()
    const visits = poi?.kind === 'points' ? poi.points.map(indexOf) : []
    expect(visits.filter((index) => index >= 0)).toHaveLength(1)
  })

  it('orders up to thirteen units exactly: no order of six points flies shorter', () => {
    const offsets: readonly (readonly [number, number])[] = [
      [40, -10],
      [-35, 25],
      [10, 60],
      [70, 45],
      [-60, -40],
      [5, -70],
    ]
    const input = {
      name: 'six points',
      design: {
        ...BASE,
        primitives: [{ kind: 'points', points: offsets.map(([e, n]) => at(e, n)) }],
      },
      envelope: ROOMY,
    }
    const flown = [FARM, ...baked(input).waypoints].map(local)
    const length = (path: readonly (readonly [number, number])[]) =>
      path.slice(1).reduce((sum, p, i) => {
        const q = path[i] ?? p
        return sum + Math.hypot(p[0] - q[0], p[1] - q[1])
      }, 0)
    const points = designFromJson(input.design).primitives.flatMap((p) =>
      p.kind === 'points' ? p.points.map(local) : [],
    )
    const permutations = (items: readonly number[]): number[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          )
    const shortest = Math.min(
      ...permutations(points.map((_, i) => i)).map((order) =>
        length([local(FARM), ...order.map((i) => points[i] ?? ([0, 0] as const))]),
      ),
    )
    expect(length(flown)).toBeCloseTo(shortest, 6)
  })

  it('splits a leg longer than the stack allows, with 1 % to spare', () => {
    const input = CASES[3] as (typeof CASES)[number]
    const { waypoints, violations } = baked(input)
    expect(violations).toEqual([])
    let before: Geodetic = FARM
    for (const waypoint of waypoints) {
      expect(distanceM(before, waypoint)).toBeLessThanOrEqual(60 * (1 - SPLIT_SLACK) + 1e-9)
      before = waypoint
    }
  })

  it('reports a point above the ceiling with its index, never moves it', () => {
    const { waypoints, violations } = baked(CASES[4] as (typeof CASES)[number])
    expect(violations.map((v) => [v.rule, v.waypointIndex])).toEqual([['height_above_max', 1]])
    expect(waypoints[1]?.heightM).toBe(150)
  })

  it('merges points closer than half a metre into the first', () => {
    const { waypoints } = baked(CASES[5] as (typeof CASES)[number])
    expect(waypoints).toHaveLength(2)
    const where = waypoints.map(local)
    for (const [index, w] of where.slice(1).entries()) {
      const prior = where[index] ?? w
      expect(Math.hypot(w[0] - prior[0], w[1] - prior[1])).toBeGreaterThanOrEqual(MERGE_M)
    }
  })

  it('says when nothing is drawn', () => {
    expect(baked(CASES[6] as (typeof CASES)[number]).violations[0]?.rule).toBe('no_waypoints')
  })

  it('keeps contracts/geometry/bake.json, which libs/soc-geo checks, its output', () => {
    const cases = CASES.map((input) => ({ ...input, baked: bakedToJson(baked(input)) }))
    if (process.env.WRITE_VECTORS === '1') {
      writeFileSync(
        VECTORS,
        `${JSON.stringify(
          {
            description:
              "Designs and the waylines the console's bake gives them (FR-WAY-07), at origin with max_arc_spacing_m, against each case's envelope. libs/soc-geo holds every bake to the design schema and to the requirement: its violations are exactly what the Python validator finds, its distance is Sky Orchestrator's, no leg is longer than the envelope's and no two points are closer than half a metre.",
            'x-version': '1.0.0',
            origin: [FARM.longitudeDeg, FARM.latitudeDeg],
            max_arc_spacing_m: 10,
            cases,
          },
          null,
          2,
        )}\n`,
      )
    }
    const kept = JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: typeof cases }
    expect(kept.cases).toEqual(JSON.parse(JSON.stringify(cases)))
  })
})
