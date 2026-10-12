// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { judge } from './waylineBake'
import { EMPTY_SKETCH, type WaylineSketch } from './waylineSketch'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const SKETCH: WaylineSketch = {
  ...EMPTY_SKETCH,
  name: 'North corridor',
  takeoff: at(0, 0),
  defaultHeightM: 30,
  speedMs: 5,
  takeoffSecurityHeightM: 20,
  primitives: [{ kind: 'route', points: [at(0, 50), at(200, 50)] }],
}
const SQUARE = { polygon: [at(-20, -20), at(100, -20), at(100, 100), at(-20, 100)], maxHeightM: 60 }
const SETTINGS = { origin: FARM, maxArcSpacingM: 10, fence: null }

describe('a sketch baked live (FR-WAY-07, FR-WAY-08)', () => {
  it('bakes nothing until the sketch is a design', () => {
    expect(judge(EMPTY_SKETCH, SETTINGS)).toEqual({ baked: null, violations: [] })
  })

  it('bakes the design, with no limit of the stack while its envelope is unknown', () => {
    const { baked, violations } = judge(SKETCH, SETTINGS)
    expect(baked?.waypoints).toHaveLength(2)
    expect(baked?.distanceM).toBeCloseTo(50 + 200, 0)
    expect(baked?.durationS).toBeCloseTo(250 / 5, 0)
    expect(violations).toEqual([])
  })

  it("adds the geofence's rules after the bake's own", () => {
    const fenced = judge(SKETCH, { ...SETTINGS, fence: SQUARE })
    expect(fenced.violations.map(({ rule, waypointIndex }) => [rule, waypointIndex])).toEqual([
      ['outside_geofence_polygon', 1],
    ])
    const empty = judge({ ...SKETCH, primitives: [] }, { ...SETTINGS, fence: SQUARE })
    expect(empty.violations.map(({ rule }) => rule)).toEqual(['no_waypoints'])
  })

  it('computes once for the form and the scene, and again when anything changes', () => {
    const first = judge(SKETCH, SETTINGS)
    expect(judge(SKETCH, SETTINGS)).toBe(first)
    expect(judge({ ...SKETCH }, SETTINGS)).not.toBe(first)
    expect(judge(SKETCH, { ...SETTINGS, maxArcSpacingM: 5 })).not.toBe(first)
  })
})
