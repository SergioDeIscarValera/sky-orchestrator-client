import { create } from 'zustand'

import type { DesignPoint, Primitive } from '../geometry/bake'
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import { EMPTY_SKETCH, type WaylineSketch } from './waylineSketch'

/** What a click on the ground does in the designer (FR-WAY-01 to FR-WAY-05). */
export type Tool = 'takeoff' | 'route' | 'points' | 'circle' | 'grid'

/**
 * What a drag or the arrow keys move: the takeoff, or a handle of the primitive open in
 * its editor: a route's or points' point or a grid's corner, a circle's centre or the
 * point on its rim where it starts.
 */
export type Handle =
  | { readonly kind: 'takeoff' }
  | { readonly kind: 'point'; readonly index: number }
  | { readonly kind: 'centre' }
  | { readonly kind: 'rim' }

/** A wayline open in the designer. */
export interface Designing {
  /** The wayline being changed, or null for a new one. */
  readonly waylineId: string | null
  readonly sketch: WaylineSketch
  readonly tool: Tool | null
  /** The clicks of the primitive being drawn, until it is finished. */
  readonly pending: readonly Geodetic[]
  /** The next circle's direction. */
  readonly clockwise: boolean
  /** The next grid's spacings, between its lines and between the points along them. */
  readonly lineSpacingM: number | null
  readonly pointSpacingM: number | null
  /** The sketches before each step, the latest last. */
  readonly past: readonly WaylineSketch[]
  /** The primitive open in its editor, by its place in the design. */
  readonly selected: number | null
  /** The handle last grabbed or focused: the one Delete removes and the arrows move. */
  readonly picked: Handle | null
  /** The sketch before the drag under way, while a handle is held. */
  readonly held: WaylineSketch | null
  /** The figure last typed into a primitive's field: a run of keys there is one step. */
  readonly typing: string | null
}

/** Steps undo can go back. */
export const UNDO_STEPS = 100

/** A new wayline starts at its takeoff point; a saved one opens with its design. */
export function startedDesign(
  wayline: { readonly id: string; readonly sketch: WaylineSketch } | null = null,
): Designing {
  return {
    waylineId: wayline?.id ?? null,
    sketch: wayline?.sketch ?? EMPTY_SKETCH,
    tool: wayline === null ? 'takeoff' : null,
    pending: [],
    clockwise: true,
    lineSpacingM: null,
    pointSpacingM: null,
    past: [],
    selected: null,
    picked: null,
    held: null,
    typing: null,
  }
}

/**
 * One step undo can take back. A run of changes to the same figure, `typing`, is one
 * step: undo goes back to before the first key, not to each one.
 */
function stepped(
  designing: Designing,
  sketch: WaylineSketch,
  typing: string | null = null,
): Designing {
  const running = typing !== null && typing === designing.typing
  return {
    ...designing,
    sketch,
    past: running ? designing.past : [...designing.past, designing.sketch].slice(-UNDO_STEPS),
    typing,
  }
}

/** A tool taken up; what was being drawn with another, and the primitive open, let go. */
export function toolChosen(designing: Designing, tool: Tool | null): Designing {
  return { ...designing, tool, pending: [], selected: null, picked: null, typing: null }
}

/** A primitive opened in its editor, or none; what was being drawn is let go. */
export function primitiveChosen(designing: Designing, index: number | null): Designing {
  if (designing.held !== null) return designing
  const valid = index !== null && index >= 0 && index < designing.sketch.primitives.length
  return {
    ...designing,
    tool: null,
    pending: [],
    selected: valid ? index : null,
    picked: null,
    typing: null,
  }
}

/** The figure typed is left: the next key in any field is a step of its own. */
export function settled(designing: Designing): Designing {
  return { ...designing, typing: null }
}

/** A primitive just drawn, open in its editor to place and size it exactly. */
function added(designing: Designing, primitive: Primitive): Designing {
  const primitives = [...designing.sketch.primitives, primitive]
  return {
    ...stepped(designing, { ...designing.sketch, primitives }),
    tool: null,
    pending: [],
    selected: primitives.length - 1,
    picked: null,
  }
}

/** The bearing from `from` to `to`, clockwise from north, in [0, 360). */
function bearingDeg(from: Geodetic, to: Geodetic): number {
  const { eastM, northM } = eastNorth(from, to)
  return ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
}

/**
 * A click on the ground: the takeoff moves there; a route, points or a grid's area gains a
 * point; a circle takes its centre, then its radius and its start from the second click.
 * With no tool, it lets go of the primitive open.
 */
export function clicked(designing: Designing, at: Geodetic): Designing {
  switch (designing.tool) {
    case null:
      return designing.held === null ? { ...designing, selected: null, picked: null } : designing
    case 'takeoff':
      return stepped(designing, { ...designing.sketch, takeoff: at })
    case 'circle': {
      const [centre] = designing.pending
      if (centre === undefined) return { ...designing, pending: [at] }
      const { eastM, northM } = eastNorth(centre, at)
      const radiusM = Math.hypot(eastM, northM)
      if (radiusM === 0) return designing
      return added(designing, {
        kind: 'circle',
        centre,
        radiusM,
        clockwise: designing.clockwise,
        startBearingDeg: bearingDeg(centre, at),
      })
    }
    default:
      return { ...designing, pending: [...designing.pending, at] }
  }
}

const positive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0

/**
 * What is being drawn, finished into the design: a route of two points or more, points
 * of one or more, a grid of three corners or more with both its spacings given. Anything else
 * stays as it is, still being drawn.
 */
export function finished(designing: Designing): Designing {
  const { tool, pending } = designing
  let primitive: Primitive | null = null
  if (tool === 'route' && pending.length >= 2) {
    primitive = { kind: 'route', points: pending }
  } else if (tool === 'points' && pending.length > 0) {
    primitive = { kind: 'points', points: pending }
  } else if (
    tool === 'grid' &&
    pending.length >= 3 &&
    positive(designing.lineSpacingM) &&
    positive(designing.pointSpacingM)
  ) {
    primitive = {
      kind: 'grid',
      area: pending,
      lineSpacingM: designing.lineSpacingM,
      pointSpacingM: designing.pointSpacingM,
    }
  }
  return primitive === null ? designing : added(designing, primitive)
}

export function removedPrimitive(designing: Designing, index: number): Designing {
  if (designing.held !== null) return designing
  if (index < 0 || index >= designing.sketch.primitives.length) return designing
  const { selected } = designing
  return {
    ...stepped(designing, {
      ...designing.sketch,
      primitives: designing.sketch.primitives.filter((_, at) => at !== index),
    }),
    selected:
      selected === null || selected === index ? null : selected - (selected > index ? 1 : 0),
    picked: selected === index ? null : designing.picked,
  }
}

/** The primitive at `index` changed by `change`, one step; nothing if it gives null. */
function primitiveChanged(
  designing: Designing,
  index: number,
  change: (primitive: Primitive) => Primitive | null,
  typing: string | null = null,
): Designing {
  const primitive = designing.sketch.primitives[index]
  if (primitive === undefined || designing.held !== null) return designing
  const changed = change(primitive)
  if (changed === null) return designing
  return stepped(
    designing,
    {
      ...designing.sketch,
      primitives: designing.sketch.primitives.map((each, at) => (at === index ? changed : each)),
    },
    typing,
  )
}

const above = (value: number) => Number.isFinite(value) && value > 0

/** A point at `place`, at `own`'s height: its own, or the default's when `own` has none. */
function atHeight(
  { latitudeDeg, longitudeDeg }: Geodetic,
  own: { readonly heightM?: number },
): DesignPoint {
  return own.heightM === undefined
    ? { latitudeDeg, longitudeDeg }
    : { latitudeDeg, longitudeDeg, heightM: own.heightM }
}

/**
 * A primitive's own height above takeoff, over the wayline's default (FR-WAY-06): on a
 * circle or a grid, theirs; on a route or points, each of their points'. Null gives the
 * default back; zero or less changes nothing.
 */
export function primitiveHeightSet(
  designing: Designing,
  index: number,
  heightM: number | null,
): Designing {
  if (heightM !== null && !above(heightM)) return designing
  const own = heightM === null ? {} : { heightM }
  return primitiveChanged(
    designing,
    index,
    (primitive): Primitive => {
      switch (primitive.kind) {
        case 'route':
        case 'points':
          return { kind: primitive.kind, points: primitive.points.map((p) => atHeight(p, own)) }
        case 'circle':
          return {
            kind: 'circle',
            centre: primitive.centre,
            radiusM: primitive.radiusM,
            clockwise: primitive.clockwise,
            startBearingDeg: primitive.startBearingDeg,
            ...own,
          }
        case 'grid':
          return {
            kind: 'grid',
            area: primitive.area,
            lineSpacingM: primitive.lineSpacingM,
            pointSpacingM: primitive.pointSpacingM,
            ...(primitive.angleDeg === undefined ? {} : { angleDeg: primitive.angleDeg }),
            ...own,
          }
      }
    },
    `height-${String(index)}`,
  )
}

/** A circle's radius, typed (FR-WAY-04): above zero, or nothing changes. */
export function circleSized(designing: Designing, index: number, radiusM: number): Designing {
  if (!above(radiusM)) return designing
  return primitiveChanged(
    designing,
    index,
    (primitive) => (primitive.kind === 'circle' ? { ...primitive, radiusM } : null),
    `radius-${String(index)}`,
  )
}

/** A circle's direction, changed after it is drawn. */
export function circleTurned(designing: Designing, index: number, clockwise: boolean): Designing {
  return primitiveChanged(designing, index, (primitive) =>
    primitive.kind === 'circle' && primitive.clockwise !== clockwise
      ? { ...primitive, clockwise }
      : null,
  )
}

/** A grid's spacing between its lines or between its points, typed (FR-WAY-05). */
export function gridRespaced(
  designing: Designing,
  index: number,
  spacing: 'lineSpacingM' | 'pointSpacingM',
  metres: number,
): Designing {
  if (!above(metres)) return designing
  return primitiveChanged(
    designing,
    index,
    (primitive) => (primitive.kind === 'grid' ? { ...primitive, [spacing]: metres } : null),
    `${spacing}-${String(index)}`,
  )
}

/** The fewest points each kind keeps: a route two, points one, a grid's area three. */
const LEAST_POINTS = { route: 2, points: 1, grid: 3 } as const

/** The points a handle moves among: a route's or points', a grid's corners. */
function pointsOf(primitive: Primitive): readonly DesignPoint[] | null {
  switch (primitive.kind) {
    case 'route':
    case 'points':
      return primitive.points
    case 'grid':
      return primitive.area
    case 'circle':
      return null
  }
}

function withPoints(primitive: Primitive, points: readonly DesignPoint[]): Primitive {
  switch (primitive.kind) {
    case 'route':
    case 'points':
      return { kind: primitive.kind, points }
    case 'grid':
      return { ...primitive, area: points }
    case 'circle':
      return primitive
  }
}

/** Where a circle starts, on its rim: the handle that sizes it. */
export function rimOf(circle: Extract<Primitive, { kind: 'circle' }>): Geodetic {
  const bearing = (circle.startBearingDeg * Math.PI) / 180
  return geodeticAt(circle.centre, {
    eastM: circle.radiusM * Math.sin(bearing),
    northM: circle.radiusM * Math.cos(bearing),
  })
}

/** Whether `handle` is one the wayline has: the takeoff placed, or one of the open primitive. */
function holds(designing: Designing, handle: Handle): boolean {
  if (handle.kind === 'takeoff') return designing.sketch.takeoff !== null
  const primitive =
    designing.selected === null ? undefined : designing.sketch.primitives[designing.selected]
  if (primitive === undefined) return false
  if (handle.kind === 'point') {
    const points = pointsOf(primitive)
    return points !== null && handle.index >= 0 && handle.index < points.length
  }
  return primitive.kind === 'circle'
}

/** A handle chosen, by focus or a click, for Delete or the arrow keys. */
export function handleChosen(designing: Designing, handle: Handle): Designing {
  return holds(designing, handle) ? { ...designing, picked: handle } : designing
}

/** A handle grabbed to drag: chosen, and the sketch before the drag kept for undo. */
export function grabbed(designing: Designing, handle: Handle): Designing {
  if (!holds(designing, handle)) return designing
  return { ...designing, picked: handle, held: designing.held ?? designing.sketch, typing: null }
}

/**
 * The middle of the open route's leg or the open grid's edge grabbed: a point is put
 * there, held, to bend it, at the height of the point before it. A grid's edges close
 * its ring; points of interest have none.
 */
export function grabbedMiddle(designing: Designing, edge: number, at: Geodetic): Designing {
  const index = designing.selected
  if (designing.held !== null || index === null) return designing
  const primitive = designing.sketch.primitives[index]
  if (primitive === undefined || primitive.kind === 'points' || primitive.kind === 'circle') {
    return designing
  }
  const points = pointsOf(primitive) ?? []
  const edges = primitive.kind === 'grid' ? points.length : points.length - 1
  const before = points[edge]
  if (before === undefined || edge >= edges) return designing
  const inserted = [...points.slice(0, edge + 1), atHeight(at, before), ...points.slice(edge + 1)]
  return {
    ...designing,
    sketch: {
      ...designing.sketch,
      primitives: designing.sketch.primitives.map((each, i) =>
        i === index ? withPoints(primitive, inserted) : each,
      ),
    },
    picked: { kind: 'point', index: edge + 1 },
    held: designing.sketch,
    typing: null,
  }
}

/** The held handle follows the pointer over the ground. */
export function dragged(designing: Designing, to: Geodetic): Designing {
  const { held, picked, selected } = designing
  if (held === null || picked === null) return designing
  if (picked.kind === 'takeoff') {
    return { ...designing, sketch: { ...designing.sketch, takeoff: to } }
  }
  const primitive = selected === null ? undefined : designing.sketch.primitives[selected]
  if (primitive === undefined) return designing
  const moved = ((): Primitive | null => {
    if (picked.kind === 'point') {
      const points = pointsOf(primitive)
      if (points === null) return null
      return withPoints(
        primitive,
        points.map((point, at) => (at === picked.index ? atHeight(to, point) : point)),
      )
    }
    if (primitive.kind !== 'circle') return null
    if (picked.kind === 'centre') return { ...primitive, centre: to }
    const { eastM, northM } = eastNorth(primitive.centre, to)
    const radiusM = Math.hypot(eastM, northM)
    if (radiusM === 0) return null
    return { ...primitive, radiusM, startBearingDeg: bearingDeg(primitive.centre, to) }
  })()
  if (moved === null) return designing
  return {
    ...designing,
    sketch: {
      ...designing.sketch,
      primitives: designing.sketch.primitives.map((each, at) => (at === selected ? moved : each)),
    },
  }
}

/** Let go: one undo step for the whole drag, none if nothing moved. */
export function released(designing: Designing): Designing {
  const { held } = designing
  if (held === null) return designing
  const moved = held !== designing.sketch
  return {
    ...designing,
    held: null,
    past: moved ? [...designing.past, held].slice(-UNDO_STEPS) : designing.past,
  }
}

/** A handle moved to `to` in one step: what an arrow key does. */
export function handleMoved(designing: Designing, handle: Handle, to: Geodetic): Designing {
  if (designing.held !== null) return designing
  return released(dragged(grabbed(designing, handle), to))
}

/**
 * Delete or Backspace: the last click of what is being drawn; else the chosen point of
 * the open primitive while it keeps its fewest; else, with no handle chosen, the open
 * primitive itself.
 */
export function deleted(designing: Designing): Designing {
  if (designing.pending.length > 0) {
    return { ...designing, pending: designing.pending.slice(0, -1) }
  }
  const { selected, picked } = designing
  if (selected === null || designing.held !== null) return designing
  if (picked === null) return removedPrimitive(designing, selected)
  if (picked.kind !== 'point') return designing
  const removed = primitiveChanged(designing, selected, (primitive) => {
    const points = pointsOf(primitive)
    if (primitive.kind === 'circle' || points === null) return null
    if (points.length <= LEAST_POINTS[primitive.kind]) return null
    return withPoints(
      primitive,
      points.filter((_, at) => at !== picked.index),
    )
  })
  return removed === designing ? designing : { ...removed, picked: null }
}

/**
 * Back one step: the last click of what is being drawn, else the last change to the
 * takeoff or the primitives. The figures typed stay as they are, and the open primitive
 * stays open while it is still there.
 */
export function undone(designing: Designing): Designing {
  if (designing.held !== null) return designing
  if (designing.pending.length > 0) {
    return { ...designing, pending: designing.pending.slice(0, -1) }
  }
  const last = designing.past.at(-1)
  if (last === undefined) return designing
  const { selected } = designing
  return {
    ...designing,
    sketch: { ...designing.sketch, takeoff: last.takeoff, primitives: last.primitives },
    past: designing.past.slice(0, -1),
    selected: selected !== null && selected < last.primitives.length ? selected : null,
    picked: null,
    typing: null,
  }
}

/** The figures typed into the form, which undo leaves alone, as the fields keep their own. */
export function figured(
  designing: Designing,
  figures: Partial<Pick<WaylineSketch, 'name' | 'defaultHeightM'>>,
): Designing {
  return { ...designing, sketch: { ...designing.sketch, ...figures } }
}

export function gridSpaced(
  designing: Designing,
  spacings: { readonly lineSpacingM?: number | null; readonly pointSpacingM?: number | null },
): Designing {
  return { ...designing, ...spacings }
}

export function turned(designing: Designing, clockwise: boolean): Designing {
  return { ...designing, clockwise }
}

interface WaylineDesigner {
  readonly designing: Designing | null
  readonly begin: (designing: Designing) => void
  /** One step, from the transitions above; nothing while no wayline is open. */
  readonly change: (step: (designing: Designing) => Designing) => void
  readonly stop: () => void
}

/**
 * The wayline open in the designer, shared by the panel's form and the scene, which live
 * in different React roots. It outlives the panel, as the geofence editor's drawing does.
 */
export const useWaylineDesigner = create<WaylineDesigner>()((set) => ({
  designing: null,
  begin: (designing) => {
    set({ designing })
  },
  change: (step) => {
    set(({ designing }) => (designing === null ? {} : { designing: step(designing) }))
  },
  stop: () => {
    set({ designing: null })
  },
}))
