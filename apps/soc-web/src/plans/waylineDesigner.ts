import { create } from 'zustand'

import type { Primitive } from '../geometry/bake'
import { eastNorth, type Geodetic } from '../geometry/projection'
import { EMPTY_SKETCH, type WaylineSketch } from './waylineSketch'

/** What a click on the ground does in the designer (FR-WAY-01 to FR-WAY-05). */
export type Tool = 'takeoff' | 'route' | 'points' | 'circle' | 'grid'

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
  }
}

function stepped(designing: Designing, sketch: WaylineSketch): Designing {
  return {
    ...designing,
    sketch,
    past: [...designing.past, designing.sketch].slice(-UNDO_STEPS),
  }
}

/** A tool taken up; what was being drawn with another is let go. */
export function toolChosen(designing: Designing, tool: Tool | null): Designing {
  return { ...designing, tool, pending: [] }
}

/** The bearing from `from` to `to`, clockwise from north, in [0, 360). */
function bearingDeg(from: Geodetic, to: Geodetic): number {
  const { eastM, northM } = eastNorth(from, to)
  return ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
}

/**
 * A click on the ground: the takeoff moves there; a route, points or a grid's area gains a
 * point; a circle takes its centre, then its radius and its start from the second click.
 */
export function clicked(designing: Designing, at: Geodetic): Designing {
  switch (designing.tool) {
    case null:
      return designing
    case 'takeoff':
      return stepped(designing, { ...designing.sketch, takeoff: at })
    case 'circle': {
      const [centre] = designing.pending
      if (centre === undefined) return { ...designing, pending: [at] }
      const { eastM, northM } = eastNorth(centre, at)
      const radiusM = Math.hypot(eastM, northM)
      if (radiusM === 0) return designing
      const circle: Primitive = {
        kind: 'circle',
        centre,
        radiusM,
        clockwise: designing.clockwise,
        startBearingDeg: bearingDeg(centre, at),
      }
      return {
        ...stepped(designing, {
          ...designing.sketch,
          primitives: [...designing.sketch.primitives, circle],
        }),
        pending: [],
      }
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
  if (primitive === null) return designing
  return {
    ...stepped(designing, {
      ...designing.sketch,
      primitives: [...designing.sketch.primitives, primitive],
    }),
    pending: [],
  }
}

export function removedPrimitive(designing: Designing, index: number): Designing {
  if (index < 0 || index >= designing.sketch.primitives.length) return designing
  return stepped(designing, {
    ...designing.sketch,
    primitives: designing.sketch.primitives.filter((_, at) => at !== index),
  })
}

/**
 * A primitive's own height above takeoff, over the wayline's default (FR-WAY-06): on a
 * circle or a grid, theirs; on a route or points, each of their points'. Null gives the
 * default back.
 */
export function primitiveHeightSet(
  designing: Designing,
  index: number,
  heightM: number | null,
): Designing {
  const primitive = designing.sketch.primitives[index]
  if (primitive === undefined) return designing
  const own = heightM === null ? {} : { heightM }
  const changed: Primitive = (() => {
    switch (primitive.kind) {
      case 'route':
      case 'points':
        return {
          kind: primitive.kind,
          points: primitive.points.map(({ latitudeDeg, longitudeDeg }) => ({
            latitudeDeg,
            longitudeDeg,
            ...own,
          })),
        }
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
  })()
  return stepped(designing, {
    ...designing.sketch,
    primitives: designing.sketch.primitives.map((each, at) => (at === index ? changed : each)),
  })
}

/**
 * Back one step: the last click of what is being drawn, else the last change to the
 * takeoff or the primitives. The figures typed stay as they are.
 */
export function undone(designing: Designing): Designing {
  if (designing.pending.length > 0) {
    return { ...designing, pending: designing.pending.slice(0, -1) }
  }
  const last = designing.past.at(-1)
  if (last === undefined) return designing
  return {
    ...designing,
    sketch: { ...designing.sketch, takeoff: last.takeoff, primitives: last.primitives },
    past: designing.past.slice(0, -1),
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
