// @vitest-environment node
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import {
  clicked,
  figured,
  finished,
  gridSpaced,
  primitiveHeightSet,
  removedPrimitive,
  startedDesign,
  toolChosen,
  turned,
  UNDO_STEPS,
  undone,
  useWaylineDesigner,
  type Designing,
  type Tool,
} from './waylineDesigner'
import { EMPTY_SKETCH } from './waylineSketch'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

function drawn(tool: Tool, ...clicks: readonly (readonly [number, number])[]): Designing {
  return clicks.reduce(
    (designing, [east, north]) => clicked(designing, at(east, north)),
    toolChosen(startedDesign(), tool),
  )
}

describe('the wayline designer (FR-WAY-01 to FR-WAY-05)', () => {
  it('opens a new wayline at its takeoff, a saved one with its design and no tool', () => {
    expect(startedDesign()).toMatchObject({
      waylineId: null,
      tool: 'takeoff',
      sketch: EMPTY_SKETCH,
    })
    const sketch = { ...EMPTY_SKETCH, name: 'North corridor' }
    expect(startedDesign({ id: 'w1', sketch })).toMatchObject({
      waylineId: 'w1',
      tool: null,
      sketch,
    })
  })

  it('places the takeoff where the ground is clicked, and moves it with the next click', () => {
    const placed = drawn('takeoff', [0, 0], [10, 5])
    expect(placed.sketch.takeoff).toEqual(at(10, 5))
    expect(undone(placed).sketch.takeoff).toEqual(at(0, 0))
  })

  it('draws a route click by click, finished into the design in the order drawn', () => {
    const route = finished(drawn('route', [0, 10], [0, 50], [40, 50]))
    expect(route.sketch.primitives).toEqual([
      { kind: 'route', points: [at(0, 10), at(0, 50), at(40, 50)] },
    ])
    expect(route.pending).toEqual([])
    expect(finished(toolChosen(startedDesign(), 'route'))).toEqual(
      toolChosen(startedDesign(), 'route'),
    )
    // One point is no route: the schema asks two at least.
    expect(finished(drawn('route', [0, 10])).pending).toHaveLength(1)
  })

  it('draws points of interest the same way', () => {
    expect(finished(drawn('points', [5, 5], [20, 30])).sketch.primitives).toEqual([
      { kind: 'points', points: [at(5, 5), at(20, 30)] },
    ])
  })

  it('takes a circle from its centre and a second click: the radius and the bearing to it', () => {
    const circle = drawn('circle', [100, 100], [130, 100])
    const [primitive] = circle.sketch.primitives
    expect(primitive?.kind).toBe('circle')
    if (primitive?.kind !== 'circle') return
    expect(primitive.centre).toEqual(at(100, 100))
    expect(primitive.radiusM).toBeCloseTo(30, 6)
    // East of the centre, on the centre's own frame: within a thousandth of a degree.
    expect(primitive.startBearingDeg).toBeCloseTo(90, 2)
    expect(primitive.clockwise).toBe(true)
    const anticlockwise = clicked(
      clicked(turned(toolChosen(startedDesign(), 'circle'), false), at(0, 0)),
      at(0, -20),
    )
    expect(anticlockwise.sketch.primitives[0]).toMatchObject({ clockwise: false })
    if (anticlockwise.sketch.primitives[0]?.kind === 'circle') {
      expect(anticlockwise.sketch.primitives[0].startBearingDeg).toBeCloseTo(180, 2)
    }
    // A second click on the centre gives no circle.
    expect(drawn('circle', [5, 5], [5, 5]).sketch.primitives).toEqual([])
  })

  it('finishes a grid only with three corners and both spacings', () => {
    const corners = drawn('grid', [0, 0], [100, 0], [100, 60])
    expect(finished(corners).sketch.primitives).toEqual([])
    const spaced = gridSpaced(corners, { lineSpacingM: 20, pointSpacingM: 10 })
    expect(finished(spaced).sketch.primitives).toEqual([
      {
        kind: 'grid',
        area: [at(0, 0), at(100, 0), at(100, 60)],
        lineSpacingM: 20,
        pointSpacingM: 10,
      },
    ])
    expect(finished(gridSpaced(spaced, { pointSpacingM: 0 })).sketch.primitives).toEqual([])
    expect(finished(drawn('grid', [0, 0], [100, 0])).pending).toHaveLength(2)
  })

  it('gives a primitive its own height, and the default back', () => {
    const route = finished(drawn('route', [0, 10], [0, 50]))
    const high = primitiveHeightSet(route, 0, 45)
    expect(high.sketch.primitives[0]).toEqual({
      kind: 'route',
      points: [
        { ...at(0, 10), heightM: 45 },
        { ...at(0, 50), heightM: 45 },
      ],
    })
    expect(primitiveHeightSet(high, 0, null).sketch.primitives).toEqual(route.sketch.primitives)
    const circle = primitiveHeightSet(drawn('circle', [0, 0], [10, 0]), 0, 25)
    expect(circle.sketch.primitives[0]).toMatchObject({ kind: 'circle', heightM: 25 })
    expect(primitiveHeightSet(circle, 0, null).sketch.primitives[0]).not.toHaveProperty('heightM')
    expect(primitiveHeightSet(circle, 3, 10)).toBe(circle)
  })

  it('removes a primitive, and undoes a click before a change', () => {
    const two = finished(drawn('points', [1, 1]))
    const routed = finished(clicked(clicked(toolChosen(two, 'route'), at(9, 9)), at(9, 30)))
    expect(removedPrimitive(routed, 0).sketch.primitives).toEqual([
      { kind: 'route', points: [at(9, 9), at(9, 30)] },
    ])
    expect(removedPrimitive(routed, 5)).toBe(routed)
    const drawing = clicked(clicked(routed, at(20, 20)), at(30, 30))
    expect(undone(drawing).pending).toEqual([at(20, 20)])
    expect(undone(undone(undone(drawing))).sketch.primitives).toEqual(two.sketch.primitives)
  })

  it('drops what was drawn with one tool when another is taken up', () => {
    expect(toolChosen(drawn('route', [0, 10]), 'points').pending).toEqual([])
  })

  it('keeps the figures typed out of undo, and a bounded history', () => {
    const named = figured(drawn('takeoff', [0, 0]), { name: 'North corridor', defaultHeightM: 30 })
    expect(undone(named).sketch).toMatchObject({
      takeoff: null,
      name: 'North corridor',
      defaultHeightM: 30,
    })
    let many = toolChosen(startedDesign(), 'takeoff')
    for (let step = 0; step < UNDO_STEPS + 10; step += 1) many = clicked(many, at(step, 0))
    expect(many.past).toHaveLength(UNDO_STEPS)
  })

  it('ignores clicks with no tool', () => {
    const idle = toolChosen(startedDesign(), null)
    expect(clicked(idle, at(1, 1))).toBe(idle)
  })
})

describe('the shared designer store', () => {
  it('steps only while a wayline is open', () => {
    const { begin, change, stop } = useWaylineDesigner.getState()
    change((designing) => clicked(designing, at(0, 0)))
    expect(useWaylineDesigner.getState().designing).toBeNull()
    begin(startedDesign())
    change((designing) => clicked(designing, at(0, 0)))
    const placed = useWaylineDesigner.getState().designing?.sketch.takeoff
    expect(
      placed === undefined || placed === null ? null : eastNorth(FARM, placed).eastM,
    ).toBeCloseTo(0, 6)
    stop()
    expect(useWaylineDesigner.getState().designing).toBeNull()
  })
})
