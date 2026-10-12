// @vitest-environment node
import { bake, type Design } from './bake'
import { planFlight, SPLIT_SLACK, type FlightSettings } from './flight'
import type { Envelope } from './limits'
import { geodeticAt, type Geodetic } from './projection'
import { distanceM } from './sphere'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** A 300 m route north and back east, high above a 30 m ceiling. */
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 80,
  primitives: [{ kind: 'route', points: [at(0, 10), at(0, 310), at(300, 310)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

const TIGHT: Envelope = {
  geofenceCenter: FARM,
  geofenceRadiusM: 50,
  maxHeightM: 30,
  maxHomeDistanceM: 50,
  maxLegM: 100,
  maxTransitM: 300,
  maxTotalDistanceM: 1000,
  maxWaypoints: 20,
  maxHorizontalSpeedMs: 3,
}

const OPERATION: FlightSettings = {
  origin: FARM,
  takeoffSecurityHeightM: 20,
  speedMs: 12,
  finishAction: 'return_home',
  envelope: null,
}

describe('a wayline flown by an operation (FR-WAY-08, FR-WAY-11)', () => {
  it("flies the bake as baked while the stack's envelope is unknown: nothing split, nothing judged", () => {
    const flight = planFlight(DESIGN.takeoff, BAKED, OPERATION)
    expect(flight.waypoints).toEqual(BAKED.waypoints)
    expect(flight.violations).toEqual([])
    expect(flight.distanceM).toBe(BAKED.distanceM)
    expect(flight.durationS).toBeCloseTo(BAKED.distanceM / 12, 9)
    expect(flight).toMatchObject({
      takeoffSecurityHeightM: 20,
      speedMs: 12,
      finishAction: 'return_home',
    })
  })

  it("splits each leg longer than the stack allows, with 1 % to spare, the bake's points kept", () => {
    const flight = planFlight(DESIGN.takeoff, BAKED, { ...OPERATION, envelope: TIGHT })
    expect(flight.waypoints.length).toBeGreaterThan(BAKED.waypoints.length)
    let before: Geodetic = DESIGN.takeoff
    for (const waypoint of flight.waypoints) {
      expect(distanceM(before, waypoint)).toBeLessThanOrEqual(100 * (1 - SPLIT_SLACK) + 1e-9)
      before = waypoint
    }
    for (const kept of BAKED.waypoints) {
      expect(flight.waypoints).toContainEqual(
        expect.objectContaining({ latitudeDeg: kept.latitudeDeg, longitudeDeg: kept.longitudeDeg }),
      )
    }
    expect(flight.waypoints.map(({ index }) => index)).toEqual(
      flight.waypoints.map((_, index) => index),
    )
    expect(flight.distanceM).toBeCloseTo(BAKED.distanceM, 6)
  })

  it("names every limit of the stack's envelope the flight breaks, none fixed", () => {
    const flight = planFlight(DESIGN.takeoff, BAKED, { ...OPERATION, envelope: TIGHT })
    expect(new Set(flight.violations.map(({ rule }) => rule))).toEqual(
      new Set(['height_above_max', 'outside_geofence', 'speed_above_max']),
    )
    expect(flight.waypoints.every(({ heightM }) => heightM <= 80)).toBe(true)
  })

  it('tells a flight with nothing to fly', () => {
    const empty = planFlight(DESIGN.takeoff, { waypoints: [], distanceM: 0 }, OPERATION)
    expect(empty.violations.map(({ rule }) => rule)).toEqual(['no_waypoints'])
  })
})
