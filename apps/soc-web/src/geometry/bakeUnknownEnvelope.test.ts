// @vitest-environment node
import { bake, type Design } from './bake'
import type { Envelope } from './limits'
import { geodeticAt, type Geodetic } from './projection'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** A 300 m route north and back east, high above a 30 m ceiling. */
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 80,
  takeoffSecurityHeightM: 20,
  speedMs: 12,
  finishAction: 'return_home',
  primitives: [{ kind: 'route', points: [at(0, 10), at(0, 310), at(300, 310)] }],
}

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

describe("a bake while the stack's envelope is unknown (FR-WAY-07, FR-WAY-08)", () => {
  it('splits no leg and checks no limit of the stack', () => {
    const unknown = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10, envelope: null })
    expect(unknown.waypoints).toHaveLength(3)
    expect(unknown.violations).toEqual([])
    expect(unknown.distanceM).toBeCloseTo(10 + 300 + 300, 0)
  })

  it('is the same wayline the known envelope splits and judges', () => {
    const known = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10, envelope: TIGHT })
    expect(known.waypoints.length).toBeGreaterThan(3)
    expect(new Set(known.violations.map(({ rule }) => rule))).toEqual(
      new Set(['height_above_max', 'outside_geofence', 'speed_above_max']),
    )
    expect(known.distanceM).toBeCloseTo(
      bake(DESIGN, { origin: FARM, maxArcSpacingM: 10, envelope: null }).distanceM,
      6,
    )
  })

  it('still tells a design with nothing drawn', () => {
    const empty = bake(
      { ...DESIGN, primitives: [] },
      { origin: FARM, maxArcSpacingM: 10, envelope: null },
    )
    expect(empty.violations.map(({ rule }) => rule)).toEqual(['no_waypoints'])
  })
})
