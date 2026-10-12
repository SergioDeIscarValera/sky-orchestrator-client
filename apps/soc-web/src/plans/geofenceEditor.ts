import { create } from 'zustand'

import type { Geodetic } from '../geometry/projection'
import {
  addVertex,
  EMPTY_DRAWING,
  insertVertex,
  moveVertex,
  removeVertex,
  type GeofenceDrawing,
} from './geofenceDrawing'

/** Placing adds a vertex at each click on the ground; shaping moves, bends and removes them. */
export type Phase = 'placing' | 'shaping'

/** What undo restores: the vertices and the phase, never the name or the ceiling typed. */
interface Shape {
  readonly vertices: readonly Geodetic[]
  readonly phase: Phase
}

/** A geofence generated round waylines (FR-GEO-03): which, and the margin it keeps. */
export interface Generating {
  readonly waylineIds: readonly string[]
  readonly marginM: number
}

/** A geofence open in the editor (FR-GEO-01). */
export interface Editing {
  /** The geofence being changed, or null for a new one. */
  readonly geofenceId: string | null
  readonly drawing: GeofenceDrawing
  readonly phase: Phase
  /** The vertex last grabbed, the one Delete removes. */
  readonly picked: number | null
  /** The shapes before each step, the latest last. */
  readonly past: readonly Shape[]
  /** The shape before the drag under way, while a vertex is held. */
  readonly held: Shape | null
  /** While generated, what from: the shape follows it, and no vertex is moved by hand. */
  readonly generating: Generating | null
}

/** A polygon needs three vertices: fewer, and the editor goes back to placing them. */
const LEAST_VERTICES = 3
/** Steps undo can go back, so a long session holds a bounded history. */
export const UNDO_STEPS = 100

/** A new geofence starts empty and placing; an existing one opens shaped. */
export function started(
  geofence: { readonly id: string; readonly drawing: GeofenceDrawing } | null,
): Editing {
  return {
    geofenceId: geofence?.id ?? null,
    drawing: geofence?.drawing ?? EMPTY_DRAWING,
    phase: geofence === null ? 'placing' : 'shaping',
    picked: null,
    past: [],
    held: null,
    generating: null,
  }
}

/** A new geofence generated round waylines, none chosen yet. */
export function startedGenerating(marginM: number): Editing {
  return { ...started(null), phase: 'shaping', generating: { waylineIds: [], marginM } }
}

/** The waylines or the margin changed, and the shape generated from them with it. */
export function regenerated(
  editing: Editing,
  generating: Generating,
  vertices: readonly Geodetic[],
): Editing {
  if (editing.generating === null) return editing
  return { ...editing, generating, drawing: { ...editing.drawing, vertices }, picked: null }
}

/** The generated shape taken on by hand: from now on it is drawn. */
export function byHand(editing: Editing): Editing {
  if (editing.generating === null) return editing
  const phase = editing.drawing.vertices.length < LEAST_VERTICES ? 'placing' : 'shaping'
  return { ...editing, generating: null, phase, past: [] }
}

function shapeOf(editing: Editing): Shape {
  return { vertices: editing.drawing.vertices, phase: editing.phase }
}

function remembered(editing: Editing, shape: Shape): readonly Shape[] {
  return [...editing.past, shape].slice(-UNDO_STEPS)
}

/** A click on the ground while placing adds a vertex at the end; while shaping, nothing. */
export function placed(editing: Editing, at: Geodetic): Editing {
  if (editing.phase !== 'placing' || editing.held !== null) return editing
  return {
    ...editing,
    drawing: addVertex(editing.drawing, at),
    picked: null,
    past: remembered(editing, shapeOf(editing)),
  }
}

/** Closing the ring, on its first vertex or with Enter, ends placing once there are three. */
export function closed(editing: Editing): Editing {
  if (editing.phase !== 'placing' || editing.drawing.vertices.length < LEAST_VERTICES) {
    return editing
  }
  return { ...editing, phase: 'shaping', picked: null, past: remembered(editing, shapeOf(editing)) }
}

/** A vertex grabbed to drag: picked, and the shape before the drag kept for undo. */
export function grabbed(editing: Editing, index: number): Editing {
  if (editing.generating !== null) return editing
  if (index < 0 || index >= editing.drawing.vertices.length) return editing
  return { ...editing, picked: index, held: editing.held ?? shapeOf(editing) }
}

/** A vertex chosen, by focus or a click, for Delete or the arrow keys. */
export function chosen(editing: Editing, index: number): Editing {
  if (index < 0 || index >= editing.drawing.vertices.length) return editing
  return { ...editing, picked: index }
}

/** An edge's middle grabbed while shaping: a new vertex there, held, to bend the edge. */
export function grabbedEdge(editing: Editing, edge: number, at: Geodetic): Editing {
  const count = editing.drawing.vertices.length
  if (editing.phase !== 'shaping' || editing.held !== null || editing.generating !== null) {
    return editing
  }
  if (edge < 0 || edge >= count) {
    return editing
  }
  return {
    ...editing,
    drawing: insertVertex(editing.drawing, edge, at),
    picked: edge + 1,
    held: shapeOf(editing),
  }
}

/** The held vertex follows the pointer over the ground. */
export function dragged(editing: Editing, to: Geodetic): Editing {
  if (editing.held === null || editing.picked === null) return editing
  return { ...editing, drawing: moveVertex(editing.drawing, editing.picked, to) }
}

/** Let go: one undo step for the whole drag, none if nothing moved. */
export function released(editing: Editing): Editing {
  const { held } = editing
  if (held === null) return editing
  const moved = held.vertices !== editing.drawing.vertices
  return { ...editing, held: null, past: moved ? remembered(editing, held) : editing.past }
}

/** A vertex removed; under three, the editor goes back to placing them. */
export function removed(editing: Editing, index: number): Editing {
  const out = index < 0 || index >= editing.drawing.vertices.length
  if (editing.held !== null || editing.generating !== null || out) {
    return editing
  }
  const drawing = removeVertex(editing.drawing, index)
  return {
    ...editing,
    drawing,
    phase: drawing.vertices.length < LEAST_VERTICES ? 'placing' : editing.phase,
    picked: null,
    past: remembered(editing, shapeOf(editing)),
  }
}

/** Delete removes the picked vertex; with none picked while placing, the last one placed. */
export function deleted(editing: Editing): Editing {
  if (editing.picked !== null) return removed(editing, editing.picked)
  if (editing.phase === 'placing') return removed(editing, editing.drawing.vertices.length - 1)
  return editing
}

/** Back one step: the vertices and the phase as they were. */
export function undone(editing: Editing): Editing {
  const last = editing.past.at(-1)
  if (last === undefined || editing.held !== null) return editing
  return {
    ...editing,
    drawing: { ...editing.drawing, vertices: last.vertices },
    phase: last.phase,
    picked: null,
    past: editing.past.slice(0, -1),
  }
}

export function renamed(editing: Editing, name: string): Editing {
  return { ...editing, drawing: { ...editing.drawing, name } }
}

/** The ceiling as typed: null while the field is empty or not a number. */
export function ceiled(editing: Editing, maxHeightM: number | null): Editing {
  return { ...editing, drawing: { ...editing.drawing, maxHeightM } }
}

interface GeofenceEditor {
  readonly editing: Editing | null
  readonly start: (
    geofence: { readonly id: string; readonly drawing: GeofenceDrawing } | null,
  ) => void
  /** One step, from the transitions above; nothing while no geofence is open. */
  readonly change: (step: (editing: Editing) => Editing) => void
  readonly stop: () => void
}

/**
 * The geofence open in the editor, shared by the panel's form and the scene's handles,
 * which live in different React roots. It outlives the panel: closing the panel puts
 * the drawing away, and opening it again brings it back as it was.
 */
export const useGeofenceEditor = create<GeofenceEditor>()((set) => ({
  editing: null,
  start: (geofence) => {
    set({ editing: started(geofence) })
  },
  change: (step) => {
    set(({ editing }) => (editing === null ? {} : { editing: step(editing) }))
  },
  stop: () => {
    set({ editing: null })
  },
}))
