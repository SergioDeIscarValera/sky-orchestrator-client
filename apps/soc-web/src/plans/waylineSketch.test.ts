// @vitest-environment node
import { bake, type Baked } from '../geometry/bake'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import {
  designOf,
  EMPTY_SKETCH,
  fenceViolations,
  sketchRefusals,
  type WaylineSketch,
} from './waylineSketch'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const READY: WaylineSketch = {
  ...EMPTY_SKETCH,
  name: 'North corridor',
  takeoff: at(0, 0),
  defaultHeightM: 30,
  speedMs: 5,
  takeoffSecurityHeightM: 20,
}

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

const baked = (sketch: WaylineSketch): Baked => {
  const design = designOf(sketch)
  if (design === null) throw new Error('not a design')
  return bake(design, { origin: FARM, maxArcSpacingM: 10, envelope: null })
}

const rules = (found: readonly { rule: string; waypointIndex?: number }[]) =>
  found.map(({ rule, waypointIndex }) => [rule, waypointIndex])

describe('a wayline being designed (FR-WAY-01, FR-WAY-06, FR-WAY-10)', () => {
  it('assumes no figure: an empty one names everything it needs', () => {
    expect(sketchRefusals(EMPTY_SKETCH)).toEqual([
      'name_missing',
      'takeoff_missing',
      'height_missing',
      'speed_missing',
      'security_height_missing',
    ])
    expect(designOf(EMPTY_SKETCH)).toBeNull()
  })

  it('refuses a figure not above zero, and bakes nothing from it', () => {
    const zero = { ...READY, defaultHeightM: 0, speedMs: -1, takeoffSecurityHeightM: Number.NaN }
    expect(sketchRefusals(zero)).toEqual([
      'height_not_positive',
      'speed_not_positive',
      'security_height_not_positive',
    ])
    expect(designOf(zero)).toBeNull()
  })

  it('refuses a climb above 120 m and a drawn height not above zero, as the schema does', () => {
    const steep = { ...READY, takeoffSecurityHeightM: 121 }
    expect(sketchRefusals(steep)).toEqual(['security_height_above_max'])
    expect(designOf(steep)).toBeNull()
    expect(sketchRefusals({ ...READY, takeoffSecurityHeightM: 120 })).toEqual([])
    const sunk = {
      ...READY,
      primitives: [
        {
          kind: 'circle' as const,
          centre: at(0, 0),
          radiusM: 10,
          clockwise: true,
          startBearingDeg: 0,
          heightM: 0,
        },
      ],
    }
    expect(sketchRefusals(sunk)).toEqual(['primitive_height_not_positive'])
    expect(designOf(sunk)).toBeNull()
  })

  it('is a design once named, placed and given its figures', () => {
    expect(sketchRefusals(READY)).toEqual([])
    expect(designOf(READY)).toEqual({
      takeoff: at(0, 0),
      defaultHeightM: 30,
      speedMs: 5,
      takeoffSecurityHeightM: 20,
      finishAction: 'return_home',
      primitives: [],
    })
  })
})

describe('a wayline against its geofence (FR-WAY-01, FR-WAY-06, FR-WAY-08)', () => {
  it('passes a route inside one arm, under the ceiling', () => {
    const inside = {
      ...READY,
      takeoff: at(10, 0),
      primitives: [{ kind: 'route' as const, points: [at(10, 20), at(20, 90)] }],
    }
    expect(fenceViolations(baked(inside), U, FARM)).toEqual([])
  })

  it('names a leg across the arms, though both its ends are inside', () => {
    const across = {
      ...READY,
      takeoff: at(10, 0),
      primitives: [{ kind: 'route' as const, points: [at(20, 80), at(80, 80)] }],
    }
    expect(rules(fenceViolations(baked(across), U, FARM))).toEqual([['leg_leaves_geofence', 1]])
  })

  it('names a point outside, and a takeoff outside, without a leg rule twice', () => {
    const outside = {
      ...READY,
      takeoff: at(50, 70),
      primitives: [{ kind: 'route' as const, points: [at(20, 80), at(200, 80)] }],
    }
    expect(rules(fenceViolations(baked(outside), U, FARM))).toEqual([
      ['takeoff_outside_geofence', undefined],
      ['outside_geofence_polygon', 1],
    ])
  })

  it('names each point above the ceiling, and a security height above it', () => {
    const high = {
      ...READY,
      takeoff: at(10, 0),
      takeoffSecurityHeightM: 70,
      primitives: [
        {
          kind: 'points' as const,
          points: [
            { ...at(10, 20), heightM: 61 },
            { ...at(20, 30), heightM: 60 },
          ],
        },
      ],
    }
    const found = fenceViolations(baked(high), U, FARM)
    expect(rules(found)).toEqual([
      ['security_height_above_geofence_ceiling', undefined],
      ['above_geofence_ceiling', 0],
    ])
    expect(found.at(-1)?.message).toBe("waypoint 0 is above the geofence's ceiling of 60 m")
  })
})
