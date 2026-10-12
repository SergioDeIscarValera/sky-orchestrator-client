// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import {
  addVertex,
  EMPTY_DRAWING,
  insertVertex,
  measure,
  moveVertex,
  refusals,
  removeVertex,
  type GeofenceDrawing,
} from './geofenceDrawing'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
/** A point `east` and `north` metres from the farm, exactly on the local frame. */
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

function drawnWith(...corners: readonly (readonly [number, number])[]): GeofenceDrawing {
  return corners.reduce<GeofenceDrawing>(
    (drawing, [east, north]) => addVertex(drawing, at(east, north)),
    {
      ...EMPTY_DRAWING,
      name: 'North field',
      maxHeightM: 60,
    },
  )
}

describe('a geofence being drawn (FR-GEO-01, FR-GEO-04)', () => {
  it('shows its area and perimeter as it is drawn', () => {
    const square = measure(drawnWith([0, 0], [100, 0], [100, 50], [0, 50]), FARM)
    expect(square.areaM2).toBeCloseTo(5000, 3)
    expect(square.perimeterM).toBeCloseTo(300, 3)
    expect(square.problems).toEqual([])
  })

  it('highlights the edges that cross, and has no area to show while they do', () => {
    const bowTie = measure(drawnWith([0, 0], [100, 100], [100, 0], [0, 100]), FARM)
    expect(bowTie.problems).toEqual([{ rule: 'edges_meet', edges: [0, 2] }])
    expect(bowTie.areaM2).toBeNull()
  })

  it('edits one vertex at a time: inserted on an edge, moved, removed', () => {
    const square = drawnWith([0, 0], [100, 0], [100, 100], [0, 100])
    const bent = insertVertex(square, 1, at(150, 50))
    expect(bent.vertices).toHaveLength(5)
    expect(measure(bent, FARM).areaM2).toBeCloseTo(10_000 + 2500, 3)
    const moved = moveVertex(bent, 2, at(120, 50))
    expect(measure(moved, FARM).areaM2).toBeCloseTo(10_000 + 1000, 3)
    expect(measure(removeVertex(moved, 2), FARM).areaM2).toBeCloseTo(10_000, 3)
    expect(moveVertex(square, 9, at(0, 0))).toBe(square)
  })

  it('cannot be saved until it is simple, with a positive ceiling within the stack and a name', () => {
    expect(refusals(drawnWith([0, 0], [100, 0], [100, 100]), FARM, 120)).toEqual([])
    expect(refusals({ ...EMPTY_DRAWING }, FARM, 120)).toEqual([
      'name_missing',
      'too_few_vertices',
      'ceiling_missing',
    ])
    expect(refusals(drawnWith([0, 0], [100, 100], [100, 0], [0, 100]), FARM, 120)).toEqual([
      'edges_meet',
    ])
    // Drawn on a line, the points come back a hair off it: a sliver, no area.
    expect(refusals(drawnWith([0, 0], [50, 50], [100, 100]), FARM, 120)).toEqual(['no_area'])
    expect(
      refusals({ ...drawnWith([0, 0], [100, 0], [100, 100]), maxHeightM: 0 }, FARM, 120),
    ).toEqual(['ceiling_not_positive'])
    expect(
      refusals({ ...drawnWith([0, 0], [100, 0], [100, 100]), maxHeightM: 150 }, FARM, 120),
    ).toEqual(['ceiling_above_envelope'])
    // With no stack's envelope known yet, the ceiling is held to being positive only.
    expect(
      refusals({ ...drawnWith([0, 0], [100, 0], [100, 100]), maxHeightM: 150 }, FARM, null),
    ).toEqual([])
  })
})
