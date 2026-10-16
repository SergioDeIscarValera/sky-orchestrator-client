// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs'

import { bake, MERGE_M, pathLengthM, type Design } from './bake'
import {
  bakedToJson,
  designFromJson,
  envelopeFromSkyOrchestrator,
  flightToJson,
} from './designJson'
import { planFlight, SPLIT_SLACK } from './flight'
import { eastNorth, geodeticAt, type Geodetic } from './projection'
import { distanceM } from './sphere'

/** contracts/geometry/bake.json: designs, their bakes and the flights made of them, which libs/soc-geo checks. */
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
  schema_version: '2.2.0',
  takeoff: near(0, 0),
  default_height_m: 30,
}

/** What an operation gives the flight of a wayline (M4): its climb, its speed, its finish. */
const OPERATION = {
  takeoff_security_height_m: 20,
  speed_ms: 5,
  finish_action: 'return_home' as const,
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

const wayline = (input: (typeof CASES)[number]) =>
  bake(designFromJson(input.design), { origin: FARM, maxArcSpacingM: 10 })

/** The wayline flown by an operation, against the case's envelope. */
const baked = (input: (typeof CASES)[number]) =>
  planFlight(designFromJson(input.design).takeoff, wayline(input), {
    origin: FARM,
    takeoffSecurityHeightM: OPERATION.takeoff_security_height_m,
    speedMs: OPERATION.speed_ms,
    finishAction: OPERATION.finish_action,
    envelope: envelopeFromSkyOrchestrator(input.envelope),
  })

const local = (point: Geodetic) => {
  const placed = eastNorth(FARM, point)
  return [placed.eastM, placed.northM] as const
}

describe('the bake (FR-WAY-07) and the flight made of it (FR-WAY-08, FR-WAY-11)', () => {
  it('bakes the same design to the same wayline, and flies it the same, every time', () => {
    for (const input of CASES) {
      expect(wayline(input)).toEqual(wayline(input))
      expect(baked(input)).toEqual(baked(input))
    }
  })

  it('keeps the wayline whole when no leg is too long: the flight is its bake', () => {
    const input = CASES[0] as (typeof CASES)[number]
    expect(baked(input).waypoints).toEqual(wayline(input).waypoints)
    expect(baked(input).distanceM).toBeCloseTo(wayline(input).distanceM, 9)
    expect(baked(input).durationS).toBeCloseTo(wayline(input).distanceM / 5, 9)
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
    // Straight up to 150 m where it is, then level to the point: above the ceiling at both.
    expect(violations.map((v) => [v.rule, v.waypointIndex])).toEqual([
      ['height_above_max', 2],
      ['height_above_max', 3],
    ])
    expect(waypoints[3]?.heightM).toBe(150)
  })

  it('merges points closer than half a metre into the first', () => {
    const { waypoints } = baked(CASES[5] as (typeof CASES)[number])
    // The climb above the takeoff, then the two points left of the three drawn.
    expect(waypoints).toHaveLength(3)
    const where = waypoints.map(local)
    for (const [index, w] of where.slice(1).entries()) {
      const prior = where[index] ?? w
      expect(Math.hypot(w[0] - prior[0], w[1] - prior[1])).toBeGreaterThanOrEqual(MERGE_M)
    }
  })

  it('climbs straight up from the takeoff to the default height before anything drawn', () => {
    const input = CASES[0] as (typeof CASES)[number]
    const design = designFromJson(input.design)
    const { waypoints, distanceM } = wayline(input)
    expect(waypoints[0]).toEqual({
      index: 0,
      latitudeDeg: design.takeoff.latitudeDeg,
      longitudeDeg: design.takeoff.longitudeDeg,
      heightM: design.defaultHeightM,
    })
    // Straight up: the climb adds nothing to the distance flown over the ground.
    expect(distanceM).toBeCloseTo(pathLengthM(design.takeoff, waypoints.slice(1)), 9)
    expect(local(waypoints[1] ?? FARM)).not.toEqual(local(design.takeoff))
  })

  it('takes a point drawn at the takeoff for the climb, at its own height', () => {
    const takeoff = FARM
    const design: Design = {
      takeoff,
      defaultHeightM: 30,
      primitives: [
        {
          kind: 'route',
          points: [
            { ...geodeticAt(FARM, { eastM: 0.2, northM: 0.1 }), heightM: 50 },
            geodeticAt(FARM, { eastM: 0, northM: 60 }),
          ],
        },
      ],
    }
    const { waypoints } = bake(design, { origin: FARM, maxArcSpacingM: 10 })
    // At 50 m, then level to the next point and straight down to its 30 m.
    expect(waypoints.map(({ heightM }) => heightM)).toEqual([50, 50, 30])
    expect(local(waypoints[0] ?? FARM)[0]).toBeCloseTo(0.2, 6)
    // Nothing drawn: no wayline, and no climb on its own.
    expect(bake({ ...design, primitives: [] }, { origin: FARM, maxArcSpacingM: 10 })).toEqual({
      waypoints: [],
      distanceM: 0,
    })
  })

  it('never flies on a slant: every leg level, or straight up or down', () => {
    for (const input of CASES) {
      const design = designFromJson(input.design)
      const { waypoints } = wayline(input)
      for (const [index, w] of waypoints.entries()) {
        const before = waypoints[index - 1]
        if (before === undefined) continue
        const level = w.heightM === before.heightM
        const vertical =
          w.latitudeDeg === before.latitudeDeg && w.longitudeDeg === before.longitudeDeg
        expect(level || vertical, `${input.name}, into waypoint ${String(index)}`).toBe(true)
      }
      if (waypoints[0] !== undefined) {
        expect(distanceM(design.takeoff, waypoints[0])).toBeLessThan(MERGE_M)
      }
    }
  })

  it('climbs where it is before going up, and descends where it arrives going down', () => {
    const p = (east: number, north: number, heightM?: number) => ({
      ...geodeticAt(FARM, { eastM: east, northM: north }),
      ...(heightM === undefined ? {} : { heightM }),
    })
    const design: Design = {
      takeoff: FARM,
      defaultHeightM: 30,
      primitives: [
        { kind: 'route', points: [p(0, 50), p(0, 100)] },
        { kind: 'route', points: [p(50, 100, 60), p(100, 100, 60), p(100, 50, 20)] },
      ],
    }
    const { waypoints } = bake(design, { origin: FARM, maxArcSpacingM: 10 })
    const where = waypoints.map((w) => [...local(w).map((m) => Math.round(m) + 0), w.heightM])
    expect(where).toEqual([
      [0, 0, 30],
      [0, 50, 30],
      [0, 100, 30],
      // Up: straight up where it is, then level.
      [0, 100, 60],
      [50, 100, 60],
      [100, 100, 60],
      // Down: level to where it goes, then straight down.
      [100, 50, 60],
      [100, 50, 20],
    ])
  })

  it('goes straight up to the first height without stopping at the default one below it', () => {
    const design: Design = {
      takeoff: FARM,
      defaultHeightM: 30,
      primitives: [
        {
          kind: 'points',
          points: [{ ...geodeticAt(FARM, { eastM: 0, northM: 80 }), heightM: 60 }],
        },
      ],
    }
    const { waypoints } = bake(design, { origin: FARM, maxArcSpacingM: 10 })
    expect(waypoints.map(({ heightM }) => heightM)).toEqual([60, 60])
    expect(waypoints[0]).toMatchObject({ ...FARM, heightM: 60 })
  })

  it('says when nothing is drawn', () => {
    expect(baked(CASES[6] as (typeof CASES)[number]).violations[0]?.rule).toBe('no_waypoints')
  })

  it('keeps contracts/geometry/bake.json, which libs/soc-geo checks, its output', () => {
    const cases = CASES.map((input) => ({
      ...input,
      baked: wayline(input).waypoints.length === 0 ? null : bakedToJson(wayline(input)),
      operation: OPERATION,
      flight: flightToJson(baked(input)),
    }))
    if (process.env.WRITE_VECTORS === '1') {
      writeFileSync(
        VECTORS,
        `${JSON.stringify(
          {
            description:
              "Designs, the waylines the console's bake gives them (FR-WAY-07) at origin with max_arc_spacing_m, and the flight an operation makes of each with its climb, speed and finish against the case's envelope (FR-WAY-08). A design with nothing drawn bakes to no wayline (null). libs/soc-geo holds every bake and flight to the design schema and to the requirement: a flight's violations are exactly what the Python validator finds, its distance is Sky Orchestrator's, no leg is longer than the envelope's and no two points are closer than half a metre.",
            'x-version': '2.2.0',
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
