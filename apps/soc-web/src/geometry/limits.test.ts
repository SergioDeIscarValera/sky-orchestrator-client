// @vitest-environment node
import { readFileSync } from 'node:fs'

import { violations, type Envelope, type Plan } from './limits'
import { distanceM } from './sphere'

/** A stored position: [longitude, latitude], GeoJSON order. */
type Position = readonly [number, number]

/** contracts/flight-files' route, a wayline flown by an operation (FR-WAY-11). */
const FLIGHT = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/flight-files/route-return-home/flight.json', import.meta.url),
    'utf8',
  ),
) as {
  reference_point: Position
  takeoff_security_height_m: number
  speed_ms: number
  waypoints: { index: number; position: Position; height_m: number }[]
}

const geodetic = ([longitudeDeg, latitudeDeg]: Position) => ({ latitudeDeg, longitudeDeg })

const PLAN: Plan = {
  referencePoint: geodetic(FLIGHT.reference_point),
  takeoffSecurityHeightM: FLIGHT.takeoff_security_height_m,
  speedMs: FLIGHT.speed_ms,
  waypoints: FLIGHT.waypoints.map((w) => ({
    index: w.index,
    position: geodetic(w.position),
    heightM: w.height_m,
  })),
}
const FARM = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const ROOMY: Envelope = {
  geofenceCenter: FARM,
  geofenceRadiusM: 500,
  maxHeightM: 120,
  maxHomeDistanceM: 500,
  maxLegM: 200,
  maxTransitM: 200,
  maxTotalDistanceM: 2000,
  maxWaypoints: 200,
  maxHorizontalSpeedMs: 15,
}

const rules = (plan: Plan, envelope: Envelope) =>
  violations(plan, envelope).map((v) => [v.rule, v.waypointIndex])

describe("Sky Orchestrator's envelope, as libs/soc-geo checks it (FR-WAY-08)", () => {
  it('lets the example fly in a roomy envelope', () => {
    expect(violations(PLAN, ROOMY, { transitionalSpeedMs: 5, expectedTakeoff: FARM })).toEqual([])
  })

  it.each([
    ['max_waypoints', { maxWaypoints: 3 }, [['too_many_waypoints', undefined]]],
    ['max_height_m', { maxHeightM: 32 }, [['height_above_max', 2]]],
    [
      'geofence',
      { geofenceRadiusM: 30 },
      [
        ['outside_geofence', 1],
        ['outside_geofence', 2],
      ],
    ],
    ['max_leg_m', { maxLegM: 30 }, [['leg_too_long', 1]]],
    ['max_total_distance_m', { maxTotalDistanceM: 100 }, [['total_distance_too_long', undefined]]],
    ['max_horizontal_speed_ms', { maxHorizontalSpeedMs: 4 }, [['speed_above_max', undefined]]],
  ] as const)('%s: refused with its code and waypoint', (_name, limits, expected) => {
    expect(rules(PLAN, { ...ROOMY, ...limits })).toEqual(expected)
  })

  it('passes a value exactly at its limit, as Sky Orchestrator does', () => {
    const points = [PLAN.referencePoint, ...PLAN.waypoints.map((w) => w.position)]
    const longest = Math.max(...points.slice(1).map((p, i) => distanceM(points[i] ?? p, p)))
    expect(
      violations(PLAN, {
        ...ROOMY,
        maxWaypoints: PLAN.waypoints.length,
        maxHeightM: Math.max(...PLAN.waypoints.map((w) => w.heightM)),
        maxLegM: longest,
        maxHorizontalSpeedMs: PLAN.speedMs,
      }),
    ).toEqual([])
  })

  it('checks the transit and home distances only with the takeoff position', () => {
    const far = { latitudeDeg: 41.655, longitudeDeg: -4.7245 }
    const envelope = { ...ROOMY, maxTransitM: 100, maxHomeDistanceM: 320 }
    expect(violations(PLAN, envelope)).toEqual([])
    expect(violations(PLAN, envelope, { expectedTakeoff: far }).map((v) => v.rule)).toEqual([
      'transit_too_long',
    ])
  })
})
