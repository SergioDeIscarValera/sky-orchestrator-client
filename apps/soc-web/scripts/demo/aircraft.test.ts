// @vitest-environment node
import { readFileSync } from 'node:fs'

import { sampleOf as consoleSampleOf } from '../../src/telemetry/sample'
import {
  AIRBORNE_MS_PER_PERCENT,
  batteryOf,
  CRUISE_SHARE,
  groundMotion,
  landedMotion,
  MODES,
  type Pose,
  poseOf,
  type Motion,
  positionOf,
  type Position,
  progressedMotion,
  returnMotion,
  returnPoseOf,
  type Route,
  routeMotion,
  routeOf,
  routePoseOf,
  sampleOf,
  tickedMotion,
  type Waypoint,
} from './aircraft.mjs'

const TAKEOFF: Position = [-4.7245, 41.6523]
const TASK_MS = 60_000
const FLIGHT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/**
 * North corridor as the designer bakes it (the demo's seeded wayline): straight up above the takeoff
 * point to 30 m, then the route, metres east and north of the takeoff point.
 */
const CORRIDOR: readonly (readonly [number, number, number])[] = [
  [0, 0, 30],
  [0, 60, 30],
  [180, 60, 30],
  [180, 140, 30],
  [0, 140, 30],
]
const WAYPOINTS: Waypoint[] = CORRIDOR.map(([east, north, height]) => ({
  position: positionOf(TAKEOFF, east, north),
  height_m: height,
}))

/** The corridor's legs in metres: 30 m of climb, then 60, 180, 80 and 180 m of route. */
const LEG_LENGTHS = [30, 60, 180, 80, 180]
const LENGTH_M = LEG_LENGTHS.reduce((sum, length) => sum + length, 0)

/** The telemetry contract's keys (contracts/broadcast/telemetry.schema.json). */
const CONTRACT = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/broadcast/telemetry.schema.json', import.meta.url),
    'utf8',
  ),
) as { readonly required: readonly string[] }

function requireRoute(route: Route | null): Route {
  if (route === null) throw new Error('the flight has waypoints')
  return route
}

const ROUTE = requireRoute(routeOf(WAYPOINTS))

/** The fraction of the route's length that lies `distance` metres along it. */
const at = (distance: number): number => distance / LENGTH_M

/**
 * Checks a pose against the values a test states: metres and degrees to six digits, the mode exactly.
 * Only the values given are checked.
 */
function expectPose(
  pose: Pose,
  expected: { east?: number; north?: number; up?: number; heading?: number; mode: number },
): void {
  if (expected.east !== undefined) expect(pose.east).toBeCloseTo(expected.east, 6)
  if (expected.north !== undefined) expect(pose.north).toBeCloseTo(expected.north, 6)
  if (expected.up !== undefined) expect(pose.up).toBeCloseTo(expected.up, 6)
  if (expected.heading !== undefined) expect(pose.heading).toBeCloseTo(expected.heading, 6)
  expect(pose.mode).toBe(expected.mode)
}

describe('the route of a flight', () => {
  it('climbs from the takeoff point to the first waypoint, then flies the waypoints, in metres of 3D length', () => {
    expect(ROUTE.lengthM).toBeCloseTo(LENGTH_M, 6)
    ROUTE.legs.forEach((leg, index) => {
      expect(leg.length, `leg ${String(index)}`).toBeCloseTo(LEG_LENGTHS[index] ?? 0, 6)
    })
  })

  it('flies the climb in automatic takeoff, and every other leg in wayline', () => {
    expect(ROUTE.legs.map((leg) => leg.mode)).toEqual([
      MODES.automaticTakeoff,
      MODES.wayline,
      MODES.wayline,
      MODES.wayline,
      MODES.wayline,
    ])
  })

  it('faces each horizontal leg along it, and a climb toward the next leg (true north is 0, clockwise)', () => {
    const headings = ROUTE.legs.map((leg) => leg.heading)
    expect(headings[0]).toBeCloseTo(0, 6)
    expect(headings[1]).toBeCloseTo(0, 6)
    expect(headings[2]).toBeCloseTo(90, 6)
    expect(headings[3]).toBeCloseTo(0, 6)
    expect(headings[4]).toBeCloseTo(-90, 6)
  })

  it('has no route for a flight with no waypoint', () => {
    expect(routeOf([])).toBeNull()
    expect(routeOf(undefined)).toBeNull()
  })

  it('adds no climb for a first waypoint on the ground, so the first leg has no length', () => {
    const flat = requireRoute(
      routeOf([
        { position: TAKEOFF, height_m: 0 },
        { position: positionOf(TAKEOFF, 0, 60), height_m: 0 },
      ]),
    )
    expect(flat.legs[0]?.length).toBe(0)
    expect(flat.legs[1]?.length).toBeCloseTo(60, 6)
    expect(flat.legs[1]?.mode).toBe(MODES.wayline)
    expectPose(routePoseOf(flat, 0.5), { up: 0, mode: MODES.idle })
  })
})

describe('the pose on the route', () => {
  it('stands on the ground at the takeoff point, idle, at the start of the task', () => {
    expectPose(routePoseOf(ROUTE, 0), { east: 0, north: 0, up: 0, heading: 0, mode: MODES.idle })
  })

  it('climbs straight up from the takeoff point in automatic takeoff', () => {
    expectPose(routePoseOf(ROUTE, at(15)), {
      east: 0,
      north: 0,
      up: 15,
      heading: 0,
      mode: MODES.automaticTakeoff,
    })
  })

  it('ends at the last waypoint, flying the wayline', () => {
    expectPose(routePoseOf(ROUTE, 1), { east: 0, north: 140, up: 30, mode: MODES.wayline })
  })

  it('is midway along the route at half its length, on the east leg, heading east', () => {
    expectPose(routePoseOf(ROUTE, 0.5), {
      east: 175,
      north: 60,
      up: 30,
      heading: 90,
      mode: MODES.wayline,
    })
  })

  it.each([
    ['the first horizontal leg', 60, 0],
    ['the east leg', 180, 90],
    ['the second north leg', 310, 0],
    ['the west leg', 440, -90],
  ])('heads along %s', (_name, distance, heading) => {
    expect(routePoseOf(ROUTE, at(distance)).heading).toBeCloseTo(heading, 6)
  })

  it('lies on the route at every tenth of its length, as an independent walk along its points finds it', () => {
    const polyline: readonly (readonly number[])[] = [[0, 0, 0], ...CORRIDOR]
    const walk = (distance: number): readonly number[] => {
      let walked = 0
      for (let index = 0; index + 1 < polyline.length; index += 1) {
        const from = polyline[index] ?? [0, 0, 0]
        const to = polyline[index + 1] ?? [0, 0, 0]
        const length = Math.hypot(...to.map((value, axis) => value - (from[axis] ?? 0)))
        if (length > 0 && distance <= walked + length) {
          const along = (distance - walked) / length
          return from.map((value, axis) => value + along * ((to[axis] ?? value) - value))
        }
        walked += length
      }
      return polyline.at(-1) ?? [0, 0, 0]
    }
    for (let tenth = 0; tenth <= 10; tenth += 1) {
      const [east = 0, north = 0, up = 0] = walk((tenth / 10) * LENGTH_M)
      const pose = routePoseOf(ROUTE, tenth / 10)
      const where = `at ${String(tenth)} tenths`
      expect(pose.east, `east ${where}`).toBeCloseTo(east, 6)
      expect(pose.north, `north ${where}`).toBeCloseTo(north, 6)
      expect(pose.up, `up ${where}`).toBeCloseTo(up, 6)
    }
  })

  it('holds a flight whose path has no length on the ground at its takeoff point', () => {
    const point = requireRoute(routeOf([{ position: TAKEOFF, height_m: 0 }]))
    expect(point.lengthM).toBe(0)
    expectPose(routePoseOf(point, 1), { east: 0, north: 0, up: 0, heading: 0, mode: MODES.idle })
  })
})

describe('a return home', () => {
  const FROM = routePoseOf(ROUTE, 1)

  it('starts where the aircraft stood', () => {
    expectPose(returnPoseOf(FROM, 0), { east: 0, north: 140, up: 30, mode: MODES.automaticReturn })
  })

  it('flies straight back above the takeoff point at its height, for two thirds of its time', () => {
    const halfway = returnPoseOf(FROM, 1 / 3)
    expectPose(halfway, { east: 0, north: 70, up: 30, mode: MODES.automaticReturn })
    // Back toward the takeoff point is due south from here: 180 degrees, or -180 as the range reads it.
    expect(Math.abs(halfway.heading)).toBeCloseTo(180, 6)
    expectPose(returnPoseOf(FROM, CRUISE_SHARE), {
      east: 0,
      north: 0,
      up: 30,
      mode: MODES.automaticReturn,
    })
  })

  it('then descends onto the takeoff point in automatic landing, and stands on the ground at its end', () => {
    expectPose(returnPoseOf(FROM, (1 + CRUISE_SHARE) / 2), {
      east: 0,
      north: 0,
      up: 15,
      mode: MODES.automaticLanding,
    })
    expectPose(returnPoseOf(FROM, 1), { east: 0, north: 0, up: 0, mode: MODES.idle })
  })

  it('keeps its heading while it descends from above the takeoff point', () => {
    const above = { east: 0, north: 0, up: 30, heading: 45, mode: MODES.wayline }
    expectPose(returnPoseOf(above, 0.8), {
      east: 0,
      north: 0,
      up: 18,
      heading: 45,
      mode: MODES.automaticLanding,
    })
  })
})

describe('the battery', () => {
  it('reads full at the start, and loses a whole percent for each interval in the air', () => {
    expect(batteryOf(0)).toBe(96)
    expect(batteryOf(AIRBORNE_MS_PER_PERCENT - 1)).toBe(96)
    expect(batteryOf(AIRBORNE_MS_PER_PERCENT)).toBe(95)
    expect(batteryOf(10 * AIRBORNE_MS_PER_PERCENT)).toBe(86)
  })

  it('never reads below 0, and is always a whole percent', () => {
    expect(batteryOf(96 * AIRBORNE_MS_PER_PERCENT)).toBe(0)
    expect(batteryOf(10_000 * AIRBORNE_MS_PER_PERCENT)).toBe(0)
    expect(Number.isInteger(batteryOf(12_345))).toBe(true)
  })
})

describe('the motion of the aircraft', () => {
  const started = routeMotion(ROUTE, TASK_MS, FLIGHT)

  it('moves a route only for its own flight', () => {
    expect(progressedMotion(started, 'other', 9000)).toBe(started)
    expect(progressedMotion(started, FLIGHT, 9000)).toMatchObject({ progressMs: 9000 })
  })

  it('counts time in the air only while the aircraft is off the ground', () => {
    const ground: Motion = groundMotion(TAKEOFF)
    expect(tickedMotion(ground, 500).airborneMs).toBe(0)
    expect(tickedMotion(started, 500).airborneMs).toBe(0)
    const climbing = progressedMotion(started, FLIGHT, 2000)
    expect(tickedMotion(climbing, 500).airborneMs).toBe(500)
  })

  it('moves a return home on by each tick, and no further than its time', () => {
    const returning = returnMotion(progressedMotion(started, FLIGHT, TASK_MS), 3000, 1)
    expect(tickedMotion(returning, 500)).toMatchObject({ kind: 'return', sinceMs: 500 })
    expect(tickedMotion({ ...returning, sinceMs: 2900 }, 500)).toMatchObject({ sinceMs: 3000 })
  })

  it('stands on the ground at its takeoff point, facing where it last faced, once a return is over', () => {
    const returning = returnMotion(progressedMotion(started, FLIGHT, TASK_MS), 3000, 1)
    const landed = landedMotion({ ...returning, sinceMs: 3000 })
    expect(landed.kind).toBe('ground')
    expect(landed.home).toEqual(TAKEOFF)
    expectPose(poseOf(landed), { east: 0, north: 0, up: 0, mode: MODES.idle })
    expect(Math.abs(landed.heading)).toBeCloseTo(180, 6)
  })
})

describe('a sample of the aircraft', () => {
  const identity = { stack: 'lab', gatewaySn: 'SOTESTDOCK01', aircraftSn: '1WNBH9E00A0042' }

  it('carries exactly the keys of the telemetry contract, and reads as the console reads them', () => {
    const sample = sampleOf(groundMotion(TAKEOFF), identity, 1_700_000_000_000)
    expect(Object.keys(sample).sort()).toEqual([...CONTRACT.required].sort())
    expect(consoleSampleOf(sample)).not.toBeNull()
  })

  it('reports the pose, the battery and the fix, stamped at the moment it is taken and sent', () => {
    const motion = progressedMotion(routeMotion(ROUTE, TASK_MS, FLIGHT), FLIGHT, 30_000)
    const sample = sampleOf(motion, identity, 1_700_000_000_000)
    const [longitude, latitude] = positionOf(TAKEOFF, 175, 60)
    expect(sample).toMatchObject({
      stack: 'lab',
      gateway_sn: 'SOTESTDOCK01',
      aircraft_sn: '1WNBH9E00A0042',
      taken_at_ms: 1_700_000_000_000,
      sent_at_ms: 1_700_000_000_000,
      battery_pct: 96,
      satellites: 18,
      gps_quality: 5,
      mode_code: MODES.wayline,
    })
    expect(sample.height_m).toBeCloseTo(30, 6)
    expect(sample.latitude_deg).toBeCloseTo(latitude, 9)
    expect(sample.longitude_deg).toBeCloseTo(longitude, 9)
    expect(sample.heading_deg).toBeCloseTo(90, 6)
    expect(sample.home_distance_m).toBeCloseTo(Math.hypot(175, 60), 6)
  })
})
