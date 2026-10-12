// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import {
  ceiled,
  closed,
  deleted,
  dragged,
  grabbed,
  grabbedEdge,
  placed,
  released,
  removed,
  renamed,
  started,
  UNDO_STEPS,
  undone,
  useGeofenceEditor,
  type Editing,
} from './geofenceEditor'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** A new geofence with these corners placed, still placing. */
function placing(...corners: readonly (readonly [number, number])[]): Editing {
  return corners.reduce((editing, [east, north]) => placed(editing, at(east, north)), started(null))
}

const SQUARE = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
] as const

describe('the geofence editor (FR-GEO-01)', () => {
  it('opens a new geofence empty and placing, an existing one shaped as saved', () => {
    expect(started(null)).toMatchObject({ geofenceId: null, phase: 'placing', past: [] })
    const drawing = {
      name: 'North field',
      vertices: [at(0, 0), at(1, 0), at(0, 1)],
      maxHeightM: 60,
    }
    expect(started({ id: 'g1', drawing })).toMatchObject({
      geofenceId: 'g1',
      drawing,
      phase: 'shaping',
    })
  })

  it('places a vertex at each click, and closes the ring only once there are three', () => {
    const two = placing([0, 0], [100, 0])
    expect(two.drawing.vertices).toEqual([at(0, 0), at(100, 0)])
    expect(closed(two)).toBe(two)
    const shaped = closed(placing(...SQUARE))
    expect(shaped.phase).toBe('shaping')
    // Shaping, a click on the ground adds nothing: only an edge's middle bends it.
    expect(placed(shaped, at(50, 50))).toBe(shaped)
  })

  it('drags a vertex as one undo step, and none when it did not move', () => {
    const shaped = closed(placing(...SQUARE))
    const held = grabbed(shaped, 2)
    expect(held.picked).toBe(2)
    const moved = released(dragged(dragged(held, at(110, 110)), at(120, 120)))
    expect(moved.drawing.vertices[2]).toEqual(at(120, 120))
    expect(moved.past).toHaveLength(shaped.past.length + 1)
    expect(undone(moved).drawing.vertices).toEqual(shaped.drawing.vertices)
    expect(released(grabbed(shaped, 2)).past).toBe(shaped.past)
  })

  it("bends an edge from its middle: a vertex inserted after the edge's start, held", () => {
    const shaped = closed(placing(...SQUARE))
    const bent = released(dragged(grabbedEdge(shaped, 1, at(100, 50)), at(150, 50)))
    expect(bent.drawing.vertices).toEqual([
      at(0, 0),
      at(100, 0),
      at(150, 50),
      at(100, 100),
      at(0, 100),
    ])
    expect(undone(bent).drawing.vertices).toEqual(shaped.drawing.vertices)
    // The closing edge, from the last vertex back to the first, bends too.
    expect(grabbedEdge(shaped, 3, at(0, 50)).drawing.vertices.at(-1)).toEqual(at(0, 50))
    // Placing, the ring is not closed yet: there are no middles to grab.
    expect(grabbedEdge(placing(...SQUARE), 1, at(100, 50))).toEqual(placing(...SQUARE))
  })

  it('removes the picked vertex, or the last placed, and goes back to placing under three', () => {
    const shaped = closed(placing(...SQUARE))
    const picked = released(grabbed(shaped, 1))
    const three = deleted(picked)
    expect(three.drawing.vertices).toEqual([at(0, 0), at(100, 100), at(0, 100)])
    expect(three.phase).toBe('shaping')
    const two = removed(three, 0)
    expect(two.phase).toBe('placing')
    expect(deleted(placing([0, 0], [5, 5])).drawing.vertices).toEqual([at(0, 0)])
    // Shaping with nothing picked, Delete has nothing to remove.
    expect(deleted(shaped)).toBe(shaped)
  })

  it('undoes vertices and phase step by step, never the name or the ceiling', () => {
    const shaped = ceiled(renamed(closed(placing(...SQUARE)), 'North field'), 60)
    const reopened = undone(shaped)
    expect(reopened.phase).toBe('placing')
    expect(reopened.drawing).toMatchObject({ name: 'North field', maxHeightM: 60 })
    expect(undone(undone(reopened)).drawing.vertices).toEqual([at(0, 0), at(100, 0)])
    const empty = started(null)
    expect(undone(empty)).toBe(empty)
  })

  it('keeps a bounded history', () => {
    let editing = started(null)
    for (let step = 0; step < UNDO_STEPS + 20; step += 1)
      editing = placed(editing, at(step, step * step))
    expect(editing.past).toHaveLength(UNDO_STEPS)
  })

  it('ignores steps that do not apply: a vertex out of range, a click or a delete mid-drag', () => {
    const shaped = closed(placing(...SQUARE))
    expect(grabbed(shaped, 4)).toBe(shaped)
    expect(removed(shaped, -1)).toBe(shaped)
    expect(dragged(shaped, at(5, 5))).toBe(shaped)
    const held = grabbed(placing([0, 0], [100, 0]), 0)
    expect(placed(held, at(9, 9))).toBe(held)
    expect(removed(held, 0)).toBe(held)
    expect(undone(held)).toBe(held)
  })
})

describe('the shared editor store', () => {
  afterEach(() => {
    useGeofenceEditor.getState().stop()
  })

  it('steps only while a geofence is open, and keeps it until stopped', () => {
    const { start, change, stop } = useGeofenceEditor.getState()
    change((editing) => placed(editing, at(0, 0)))
    expect(useGeofenceEditor.getState().editing).toBeNull()
    start(null)
    change((editing) => placed(editing, at(0, 0)))
    expect(useGeofenceEditor.getState().editing?.drawing.vertices).toEqual([at(0, 0)])
    stop()
    expect(useGeofenceEditor.getState().editing).toBeNull()
  })
})
