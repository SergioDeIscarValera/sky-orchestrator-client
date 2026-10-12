import type { Wayline, WaylineDraft, Waypoint } from '../backend/backend'
import { BAKE_VERSION, type Baked, type Design, type Primitive } from '../geometry/bake'
import { designFromJson, designToJson } from '../geometry/designJson'
import { formatLength } from './format'
import { startedDesign, type Designing } from './waylineDesigner'
import type { WaylineSketch } from './waylineSketch'

/** How long a flight takes, in minutes and seconds. */
export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return minutes === 0
    ? `${String(rest)} s`
    : `${String(minutes)} min ${String(rest).padStart(2, '0')} s`
}

/** What the list and the inspector say under a wayline's name. */
export function waylineSummary(wayline: Wayline): string {
  const { waypointCount, distanceM, durationS } = wayline.metrics
  return `${String(waypointCount)} waypoints · ${formatLength(distanceM)} · ${formatDuration(durationS)}`
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
    speedMs: design.speedMs,
    design: written,
    waypoints: baked.waypoints.map(({ index, latitudeDeg, longitudeDeg, heightM }): Waypoint => ({
      index,
      position: { latitudeDeg, longitudeDeg },
      heightM,
    })),
    metrics: {
      waypointCount: baked.waypoints.length,
      distanceM: baked.distanceM,
      durationS: baked.durationS,
    },
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
    speedMs: design.speedMs,
    takeoffSecurityHeightM: design.takeoffSecurityHeightM,
    finishAction: design.finishAction,
    primitives: design.primitives,
  }
  return startedDesign({ id: wayline.id, sketch })
}

/** The height a saved wayline climbs to first, from its design; null if the design does not read. */
export function climbOf(wayline: Wayline): number | null {
  try {
    return designFromJson(wayline.design).takeoffSecurityHeightM
  } catch {
    return null
  }
}
