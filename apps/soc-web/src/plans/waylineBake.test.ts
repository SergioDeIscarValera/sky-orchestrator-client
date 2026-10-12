// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { bakeSketch } from './waylineBake'
import { EMPTY_SKETCH, type WaylineSketch } from './waylineSketch'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const SKETCH: WaylineSketch = {
  ...EMPTY_SKETCH,
  name: 'North corridor',
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(200, 50)] }],
}
const SETTINGS = { origin: FARM, maxArcSpacingM: 10 }

describe('a sketch baked live (FR-WAY-07)', () => {
  it('bakes nothing until the sketch is a design', () => {
    expect(bakeSketch(EMPTY_SKETCH, SETTINGS)).toBeNull()
  })

  it('bakes the design into its waypoints and their distance, nothing of a flight', () => {
    const baked = bakeSketch(SKETCH, SETTINGS)
    // Straight up above the takeoff first, then the route.
    expect(baked?.waypoints.map(({ heightM }) => heightM)).toEqual([30, 30, 30])
    expect(baked?.distanceM).toBeCloseTo(50 + 200, 0)
    expect(Object.keys(baked ?? {})).toEqual(['waypoints', 'distanceM'])
  })

  it('computes once for the form and the scene, and again when anything changes', () => {
    const first = bakeSketch(SKETCH, SETTINGS)
    expect(bakeSketch(SKETCH, SETTINGS)).toBe(first)
    expect(bakeSketch({ ...SKETCH }, SETTINGS)).not.toBe(first)
    expect(bakeSketch(SKETCH, { ...SETTINGS, maxArcSpacingM: 5 })).not.toBe(first)
  })
})
