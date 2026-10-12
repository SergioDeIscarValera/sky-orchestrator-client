import { perimeter, problems, signedArea, type Point, type Problem } from '../geometry/planar'
import { eastNorth, type Geodetic } from '../geometry/projection'

/**
 * A geofence being drawn (FR-GEO-01): its vertices in order, its ceiling and its name,
 * edited one step at a time. Every step returns a new drawing; nothing is saved until the
 * drawing can be (FR-GEO-04).
 */
export interface GeofenceDrawing {
  readonly name: string
  readonly vertices: readonly Geodetic[]
  /** Above the takeoff point (ADR-0014); null until given. */
  readonly maxHeightM: number | null
}

export const EMPTY_DRAWING: GeofenceDrawing = { name: '', vertices: [], maxHeightM: null }

/**
 * Less area than this is none (FR-GEO-04): vertices drawn on a line come back from the
 * map a hair off it, and the exact test would call that sliver a polygon.
 */
export const LEAST_AREA_M2 = 1

export function addVertex(drawing: GeofenceDrawing, at: Geodetic): GeofenceDrawing {
  return { ...drawing, vertices: [...drawing.vertices, at] }
}

/** A vertex put on edge `edge`, between its ends: dragging an edge's middle bends it. */
export function insertVertex(
  drawing: GeofenceDrawing,
  edge: number,
  at: Geodetic,
): GeofenceDrawing {
  const vertices = [...drawing.vertices]
  vertices.splice(edge + 1, 0, at)
  return { ...drawing, vertices }
}

export function moveVertex(drawing: GeofenceDrawing, index: number, to: Geodetic): GeofenceDrawing {
  if (index < 0 || index >= drawing.vertices.length) return drawing
  return {
    ...drawing,
    vertices: drawing.vertices.map((vertex, at) => (at === index ? to : vertex)),
  }
}

export function removeVertex(drawing: GeofenceDrawing, index: number): GeofenceDrawing {
  return { ...drawing, vertices: drawing.vertices.filter((_, at) => at !== index) }
}

/** What the drawing shows while it changes: the polygon on the local frame and its figures. */
export interface Measured {
  readonly polygon: readonly Point[]
  /** Square metres, null while the polygon is not simple. */
  readonly areaM2: number | null
  readonly perimeterM: number
  /** Why the polygon is not simple, with the edges to highlight (FR-GEO-01). */
  readonly problems: readonly Problem[]
}

export function measure(drawing: GeofenceDrawing, origin: Geodetic): Measured {
  const polygon = drawing.vertices.map((vertex): Point => {
    const placed = eastNorth(origin, vertex)
    return [placed.eastM, placed.northM]
  })
  const found = problems(polygon)
  return {
    polygon,
    areaM2: found.length === 0 ? Math.abs(signedArea(polygon)) : null,
    perimeterM: polygon.length < 2 ? 0 : perimeter(polygon),
    problems: found,
  }
}

/** Why a drawing cannot be saved yet, each in a word the editor shows beside Save. */
export type Refusal =
  | 'name_missing'
  | 'too_few_vertices'
  | 'edges_meet'
  | 'zero_length_edge'
  | 'no_area'
  | 'ceiling_missing'
  | 'ceiling_not_positive'
  | 'ceiling_above_envelope'

/**
 * Every reason the drawing is not a valid geofence (FR-GEO-04): a polygon simple with at
 * least three vertices and some area, a positive ceiling within the stack's, a name.
 * None means it can be saved.
 */
export function refusals(
  drawing: GeofenceDrawing,
  origin: Geodetic,
  envelopeCeilingM: number | null,
): Refusal[] {
  const found: Refusal[] = []
  if (drawing.name.trim() === '') found.push('name_missing')
  const measured = measure(drawing, origin)
  for (const { rule } of measured.problems) {
    if (!found.includes(rule)) found.push(rule)
  }
  if (measured.areaM2 !== null && measured.areaM2 < LEAST_AREA_M2) found.push('no_area')
  if (drawing.maxHeightM === null) found.push('ceiling_missing')
  else if (!(drawing.maxHeightM > 0)) found.push('ceiling_not_positive')
  else if (envelopeCeilingM !== null && drawing.maxHeightM > envelopeCeilingM) {
    found.push('ceiling_above_envelope')
  }
  return found
}
