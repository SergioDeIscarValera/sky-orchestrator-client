// @vitest-environment node
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import {
  circleSized,
  circleTurned,
  clicked,
  deleted,
  dragged,
  figured,
  finished,
  grabbed,
  grabbedMiddle,
  gridRespaced,
  gridSpaced,
  handleChosen,
  handleMoved,
  primitiveChosen,
  primitiveHeightSet,
  released,
  removedPrimitive,
  rimOf,
  settled,
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
    const drawing = clicked(clicked(toolChosen(routed, 'route'), at(20, 20)), at(30, 30))
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

  it('lets go of the open primitive at a click with no tool, and draws nothing', () => {
    const idle = toolChosen(startedDesign(), null)
    expect(clicked(idle, at(1, 1))).toEqual(idle)
    const route = finished(drawn('route', [0, 10], [0, 50]))
    expect(route.selected).toBe(0)
    const away = clicked(route, at(1, 1))
    expect([away.selected, away.sketch]).toEqual([null, route.sketch])
  })
})

/** A route drawn and finished, open in its editor, its second point at 45 m of its own. */
function openRoute(): Designing {
  const route = finished(drawn('route', [0, 0], [0, 50], [40, 50]))
  return settled(primitiveHeightSet(route, 0, 45))
}

const local = (point: Geodetic) => {
  const { eastM, northM } = eastNorth(FARM, point)
  return [eastM, northM]
}

describe('editing what is drawn (FR-WAY-02 to FR-WAY-06)', () => {
  it('opens what was just drawn in its editor, and lets go of the tool', () => {
    const route = finished(drawn('route', [0, 0], [0, 50]))
    expect([route.selected, route.tool, route.pending]).toEqual([0, null, []])
    const circle = drawn('circle', [0, 0], [30, 0])
    expect([circle.selected, circle.tool]).toEqual([0, null])
    const both = finished(clicked(clicked(toolChosen(circle, 'points'), at(5, 5)), at(9, 9)))
    expect(both.selected).toBe(1)
  })

  it('opens a primitive, or none, letting go of what is being drawn and of a tool', () => {
    const route = openRoute()
    const drawing = clicked(toolChosen(route, 'points'), at(3, 3))
    expect(drawing.selected).toBeNull()
    const reopened = primitiveChosen(drawing, 0)
    expect([reopened.selected, reopened.tool, reopened.pending]).toEqual([0, null, []])
    expect(primitiveChosen(route, 4).selected).toBeNull()
    expect(primitiveChosen(route, null).selected).toBeNull()
  })

  it("drags a route's point as one undo step, keeping the point's own height", () => {
    const route = openRoute()
    const held = grabbed(route, { kind: 'point', index: 1 })
    const moved = released(dragged(dragged(held, at(5, 55)), at(10, 60)))
    expect(moved.sketch.primitives[0]).toEqual({
      kind: 'route',
      points: [
        { ...at(0, 0), heightM: 45 },
        { ...at(10, 60), heightM: 45 },
        { ...at(40, 50), heightM: 45 },
      ],
    })
    expect(moved.past).toHaveLength(route.past.length + 1)
    expect(moved.picked).toEqual({ kind: 'point', index: 1 })
    expect(undone(moved).sketch.primitives).toEqual(route.sketch.primitives)
    // A press with no move leaves no step.
    expect(released(grabbed(route, { kind: 'point', index: 1 })).past).toBe(route.past)
  })

  it('moves only handles the wayline has', () => {
    const route = openRoute()
    expect(grabbed(route, { kind: 'point', index: 3 })).toBe(route)
    expect(grabbed(route, { kind: 'centre' })).toBe(route)
    expect(grabbed(primitiveChosen(route, null), { kind: 'point', index: 0 }).held).toBeNull()
    expect(grabbed(startedDesign(), { kind: 'takeoff' }).held).toBeNull()
    const placed = clicked(startedDesign(), at(0, 0))
    expect(handleMoved(placed, { kind: 'takeoff' }, at(3, 4)).sketch.takeoff).toEqual(at(3, 4))
    expect(handleChosen(route, { kind: 'rim' })).toBe(route)
    expect(handleChosen(route, { kind: 'point', index: 2 }).picked).toEqual({
      kind: 'point',
      index: 2,
    })
  })

  it("bends a route's leg from its middle, at the height of the point before", () => {
    const route = openRoute()
    const bent = released(dragged(grabbedMiddle(route, 0, at(0, 25)), at(-10, 25)))
    const primitive = bent.sketch.primitives[0]
    expect(primitive?.kind === 'route' ? primitive.points : []).toEqual([
      { ...at(0, 0), heightM: 45 },
      { ...at(-10, 25), heightM: 45 },
      { ...at(0, 50), heightM: 45 },
      { ...at(40, 50), heightM: 45 },
    ])
    expect(bent.past).toHaveLength(route.past.length + 1)
    expect(undone(bent).sketch.primitives).toEqual(route.sketch.primitives)
    // A route's last point ends it: no leg after it.
    expect(grabbedMiddle(route, 2, at(0, 0))).toBe(route)
  })

  it("bends a grid's closing edge too, and gives points of interest no middles", () => {
    const grid = finished(
      gridSpaced(drawn('grid', [0, 0], [100, 0], [100, 60]), {
        lineSpacingM: 20,
        pointSpacingM: 10,
      }),
    )
    const bent = released(grabbedMiddle(grid, 2, at(50, 30)))
    const area = bent.sketch.primitives[0]
    expect(area?.kind === 'grid' ? area.area : []).toEqual([
      at(0, 0),
      at(100, 0),
      at(100, 60),
      at(50, 30),
    ])
    const points = finished(drawn('points', [0, 0], [9, 9]))
    expect(grabbedMiddle(points, 0, at(4, 4))).toBe(points)
  })

  it('moves a circle by its centre and sizes it by its rim, where it starts', () => {
    const circle = drawn('circle', [100, 100], [130, 100])
    const original = circle.sketch.primitives[0]
    if (original?.kind !== 'circle') throw new Error('no circle')
    expect(local(rimOf(original))[0]).toBeCloseTo(130, 3)
    const moved = handleMoved(circle, { kind: 'centre' }, at(0, 0))
    expect(moved.sketch.primitives[0]).toMatchObject({
      centre: at(0, 0),
      radiusM: original.radiusM,
      startBearingDeg: original.startBearingDeg,
    })
    const sized = handleMoved(circle, { kind: 'rim' }, at(100, 140))
    const resized = sized.sketch.primitives[0]
    if (resized?.kind !== 'circle') throw new Error('no circle')
    expect(resized.radiusM).toBeCloseTo(40, 3)
    expect(resized.startBearingDeg).toBeCloseTo(0, 2)
    expect(local(rimOf(resized))[1]).toBeCloseTo(140, 3)
    expect(handleMoved(circle, { kind: 'rim' }, at(100, 100))).toEqual({
      ...circle,
      picked: { kind: 'rim' },
    })
  })

  it("types a circle's radius exactly: a run of keys is one step", () => {
    const circle = settled(drawn('circle', [0, 0], [30, 0]))
    const typed = circleSized(circleSized(circle, 0, 4), 0, 45)
    expect(typed.sketch.primitives[0]).toMatchObject({ radiusM: 45 })
    expect(typed.past).toHaveLength(circle.past.length + 1)
    expect(undone(typed).sketch.primitives).toEqual(circle.sketch.primitives)
    const again = circleSized(settled(typed), 0, 50)
    expect(again.past).toHaveLength(typed.past.length + 1)
    for (const refused of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(circleSized(circle, 0, refused)).toBe(circle)
    }
    expect(circleSized(openRoute(), 0, 10).sketch).toEqual(openRoute().sketch)
  })

  it('turns a circle after it is drawn', () => {
    const circle = drawn('circle', [0, 0], [30, 0])
    expect(circleTurned(circle, 0, false).sketch.primitives[0]).toMatchObject({ clockwise: false })
    expect(circleTurned(circle, 0, true)).toBe(circle)
  })

  it("types a grid's spacings, each field its own run of keys", () => {
    const grid = settled(
      finished(
        gridSpaced(drawn('grid', [0, 0], [100, 0], [100, 60]), {
          lineSpacingM: 20,
          pointSpacingM: 10,
        }),
      ),
    )
    const lines = gridRespaced(gridRespaced(grid, 0, 'lineSpacingM', 2), 0, 'lineSpacingM', 25)
    expect(lines.past).toHaveLength(grid.past.length + 1)
    const points = gridRespaced(lines, 0, 'pointSpacingM', 12)
    expect(points.past).toHaveLength(grid.past.length + 2)
    expect(points.sketch.primitives[0]).toMatchObject({ lineSpacingM: 25, pointSpacingM: 12 })
    expect(gridRespaced(grid, 0, 'pointSpacingM', 0)).toBe(grid)
    expect(gridRespaced(openRoute(), 0, 'lineSpacingM', 5).sketch).toEqual(openRoute().sketch)
  })

  it('types a height as one step, and refuses one not above zero', () => {
    const route = settled(finished(drawn('route', [0, 0], [0, 50])))
    const typed = primitiveHeightSet(primitiveHeightSet(route, 0, 4), 0, 45)
    expect(typed.past).toHaveLength(route.past.length + 1)
    expect(primitiveHeightSet(route, 0, 0)).toBe(route)
    expect(primitiveHeightSet(route, 0, -3)).toBe(route)
  })

  it('deletes the chosen point while its primitive keeps its fewest, else the primitive', () => {
    const route = openRoute()
    const chosen = handleChosen(route, { kind: 'point', index: 1 })
    const shorter = deleted(chosen)
    const left = shorter.sketch.primitives[0]
    expect(left?.kind === 'route' ? left.points.length : 0).toBe(2)
    expect(shorter.picked).toBeNull()
    // Two points are the fewest a route keeps.
    const fewest = handleChosen(shorter, { kind: 'point', index: 0 })
    expect(deleted(fewest)).toBe(fewest)
    // With no handle chosen, Delete takes the primitive open.
    const gone = deleted(shorter)
    expect([gone.sketch.primitives, gone.selected]).toEqual([[], null])
    const circle = handleChosen(drawn('circle', [0, 0], [9, 0]), { kind: 'centre' })
    expect(deleted(circle)).toBe(circle)
    // Drawing, Delete takes back the last click.
    expect(deleted(drawn('route', [0, 0], [5, 5])).pending).toEqual([at(0, 0)])
    expect(deleted(startedDesign())).toEqual(startedDesign())
  })

  it('keeps the open primitive open when another is removed, as long as it is there', () => {
    const two = finished(clicked(clicked(toolChosen(openRoute(), 'points'), at(1, 1)), at(2, 2)))
    expect(two.selected).toBe(1)
    expect(removedPrimitive(two, 0).selected).toBe(0)
    expect(removedPrimitive(two, 1).selected).toBeNull()
    const first = primitiveChosen(two, 0)
    expect(removedPrimitive(first, 1).selected).toBe(0)
    expect(undone(two).selected).toBeNull()
    expect(undone(removedPrimitive(two, 0)).selected).toBe(0)
  })

  it('holds still while a handle is held: no undo, removal, choice or click', () => {
    const held = grabbed(openRoute(), { kind: 'point', index: 0 })
    expect(undone(held)).toBe(held)
    expect(removedPrimitive(held, 0)).toBe(held)
    expect(primitiveChosen(held, null)).toBe(held)
    expect(deleted(held)).toBe(held)
    expect(clicked(held, at(9, 9))).toBe(held)
    expect(grabbedMiddle(held, 0, at(1, 1))).toBe(held)
    expect(circleSized(held, 0, 5)).toBe(held)
    expect(handleMoved(held, { kind: 'point', index: 1 }, at(1, 1))).toBe(held)
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
