import type { Wayline, WaylineDraft, Waypoint } from '../backend/backend'
import { BAKE_VERSION, type Baked, type Design, type Primitive } from '../geometry/bake'
import { designFromJson, designToJson } from '../geometry/designJson'
import { formatLength } from './format'
import { startedDesign, type Designing } from './waylineDesigner'
import type { WaylineSketch } from './waylineSketch'

/** What the list and the inspector say under a wayline's name. */
export function waylineSummary(wayline: Wayline): string {
  const { waypointCount, distanceM } = wayline.metrics
  const waypoints = waypointCount === 1 ? '1 waypoint' : `${String(waypointCount)} waypoints`
  return `${waypoints} · ${formatLength(distanceM)}`
}

/** A primitive in a word and its size, as the designer lists them. */
export function primitiveSummary(primitive: Primitive): string {
  switch (primitive.kind) {
    case 'route':
      return `Route · ${String(primitive.points.length)} points`
    case 'points':
      return `Points · ${String(primitive.points.length)}`
    case 'circle':
      return `Circle · ${formatLength(primitive.radiusM)} radius`
    case 'grid':
      return `Grid · ${formatLength(primitive.lineSpacingM)} lines`
  }
}

/** The primitive's own height, if it gives one: a circle's or a grid's, a route's points'. */
export function ownHeightOf(primitive: Primitive): number | null {
  if (primitive.kind === 'circle' || primitive.kind === 'grid') return primitive.heightM ?? null
  const heights = new Set(primitive.points.map(({ heightM }) => heightM))
  const [only] = heights
  return heights.size === 1 && only !== undefined ? only : null
}

/**
 * The wayline the designer saves: its design and its bake together (IR-WAY-01, FR-WAY-09).
 * The design is read back as the schema reads it before anything is written, so a design
 * the schema refuses is never saved: the refusal names where.
 */
export function draftOf(name: string, design: Design, baked: Baked): WaylineDraft {
  const written = designToJson(design)
  designFromJson(written)
  return {
    name: name.trim(),
    takeoff: design.takeoff,
    defaultHeightM: design.defaultHeightM,
    design: written,
    waypoints: baked.waypoints.map(({ index, latitudeDeg, longitudeDeg, heightM }): Waypoint => ({
      index,
      position: { latitudeDeg, longitudeDeg },
      heightM,
    })),
    metrics: { waypointCount: baked.waypoints.length, distanceM: baked.distanceM },
    bakeVersion: BAKE_VERSION,
  }
}

/** A saved wayline as the designer opens it: its design read back, refused if unreadable. */
export function designingOf(wayline: Wayline): Designing {
  const design = designFromJson(wayline.design)
  const sketch: WaylineSketch = {
    name: wayline.name,
    takeoff: design.takeoff,
    defaultHeightM: design.defaultHeightM,
    primitives: design.primitives,
  }
  return startedDesign({ id: wayline.id, sketch })
}
