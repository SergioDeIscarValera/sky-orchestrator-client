// @vitest-environment node
import { bake, type Design } from '../geometry/bake'
import { planFlight, type Flight } from '../geometry/flight'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { fenceViolations } from './fenceRules'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** A U open to the north: two arms, x 0 to 40 and 60 to 100, joined below y 40. */
const U = {
  polygon: [
    at(-10, -10),
    at(110, -10),
    at(110, 100),
    at(60, 100),
    at(60, 40),
    at(40, 40),
    at(40, 100),
    at(-10, 100),
  ],
  maxHeightM: 60,
}

/** The wayline flown by an operation climbing to `climbM`. */
function flown(design: Design, climbM = 20): Flight {
  return planFlight(design.takeoff, bake(design, { origin: FARM, maxArcSpacingM: 10 }), {
    origin: FARM,
    takeoffSecurityHeightM: climbM,
    speedMs: 5,
    finishAction: 'return_home',
    envelope: null,
  })
}

const rules = (found: readonly { rule: string; waypointIndex?: number }[]) =>
  found.map(({ rule, waypointIndex }) => [rule, waypointIndex])

describe("a flight against its operation's geofence (FR-WAY-01, FR-WAY-06, FR-WAY-08)", () => {
  it('passes a route inside one arm, under the ceiling', () => {
    const inside = flown({
      takeoff: at(10, 0),
      defaultHeightM: 30,
      primitives: [{ kind: 'route', points: [at(10, 20), at(20, 90)] }],
    })
    expect(fenceViolations(inside, U, FARM)).toEqual([])
  })

  it('names a leg across the arms, though both its ends are inside', () => {
    const across = flown({
      takeoff: at(10, 0),
      defaultHeightM: 30,
      primitives: [{ kind: 'route', points: [at(20, 80), at(80, 80)] }],
    })
    expect(rules(fenceViolations(across, U, FARM))).toEqual([['leg_leaves_geofence', 1]])
  })

  it('names a point outside, and a takeoff outside, without a leg rule twice', () => {
    const outside = flown({
      takeoff: at(50, 70),
      defaultHeightM: 30,
      primitives: [{ kind: 'route', points: [at(20, 80), at(200, 80)] }],
    })
    expect(rules(fenceViolations(outside, U, FARM))).toEqual([
      ['takeoff_outside_geofence', undefined],
      ['outside_geofence_polygon', 1],
    ])
  })

  it('names each point above the ceiling, and a climb above it', () => {
    const high = flown(
      {
        takeoff: at(10, 0),
        defaultHeightM: 30,
        primitives: [
          {
            kind: 'points',
            points: [
              { ...at(10, 20), heightM: 61 },
              { ...at(20, 30), heightM: 60 },
            ],
          },
        ],
      },
      70,
    )
    const found = fenceViolations(high, U, FARM)
    expect(rules(found)).toEqual([
      ['security_height_above_geofence_ceiling', undefined],
      ['above_geofence_ceiling', 0],
    ])
    expect(found.at(-1)?.message).toBe("waypoint 0 is above the geofence's ceiling of 60 m")
  })
})
