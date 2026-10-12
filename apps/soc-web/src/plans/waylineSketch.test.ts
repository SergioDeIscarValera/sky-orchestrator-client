// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { designOf, EMPTY_SKETCH, sketchRefusals, type WaylineSketch } from './waylineSketch'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const ROUTE = { kind: 'route' as const, points: [at(0, 10), at(0, 50)] }
const READY: WaylineSketch = {
  ...EMPTY_SKETCH,
  name: 'North corridor',
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [ROUTE],
}

describe('a wayline being designed (FR-WAY-01, FR-WAY-06)', () => {
  it('assumes no figure: an empty one names everything it needs', () => {
    expect(sketchRefusals(EMPTY_SKETCH)).toEqual([
      'name_missing',
      'takeoff_missing',
      'height_missing',
      'nothing_drawn',
    ])
    expect(designOf(EMPTY_SKETCH)).toBeNull()
  })

  it('refuses a height not above zero, its own or a drawn one, and bakes nothing from it', () => {
    expect(sketchRefusals({ ...READY, defaultHeightM: 0 })).toEqual(['height_not_positive'])
    expect(designOf({ ...READY, defaultHeightM: Number.NaN })).toBeNull()
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

  it('is a design once named, placed, given its height and drawn: geometry, nothing of a flight', () => {
    expect(sketchRefusals(READY)).toEqual([])
    expect(designOf(READY)).toEqual({ takeoff: at(0, 0), defaultHeightM: 30, primitives: [ROUTE] })
  })

  it('bakes before anything is drawn, so the takeoff shows, but saves nothing yet', () => {
    const bare = { ...READY, primitives: [] }
    expect(designOf(bare)).toEqual({ takeoff: at(0, 0), defaultHeightM: 30, primitives: [] })
    expect(sketchRefusals(bare)).toEqual(['nothing_drawn'])
  })
})
