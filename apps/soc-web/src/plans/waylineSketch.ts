import type { Baked, Design, FinishAction, Primitive } from '../geometry/bake'
import type { Violation } from '../geometry/limits'
import { legClearance, locate, type Point } from '../geometry/planar'
import { eastNorth, type Geodetic } from '../geometry/projection'

/**
 * A wayline being designed (FR-WAY-01 to FR-WAY-10): its takeoff point, its figures and
 * its drawn primitives. A figure is null until given: none is assumed, so nothing flies
 * at a height or a speed nobody chose.
 */
export interface WaylineSketch {
  readonly name: string
  readonly takeoff: Geodetic | null
  /** Above the takeoff point (ADR-0014), for every point that gives none of its own. */
  readonly defaultHeightM: number | null
  readonly speedMs: number | null
  /** The height the aircraft climbs to over the takeoff before it sets off. */
  readonly takeoffSecurityHeightM: number | null
  readonly finishAction: FinishAction
  readonly primitives: readonly Primitive[]
}

export const EMPTY_SKETCH: WaylineSketch = {
  name: '',
  takeoff: null,
  defaultHeightM: null,
  speedMs: null,
  takeoffSecurityHeightM: null,
  finishAction: 'return_home',
  primitives: [],
}

/** Why a sketch cannot be baked or saved yet, each in a word the designer shows. */
export type SketchRefusal =
  | 'name_missing'
  | 'takeoff_missing'
  | 'height_missing'
  | 'height_not_positive'
  | 'speed_missing'
  | 'speed_not_positive'
  | 'security_height_missing'
  | 'security_height_not_positive'
  | 'security_height_above_max'
  | 'primitive_height_not_positive'

const positive = (value: number) => Number.isFinite(value) && value > 0

/** The highest climb over the takeoff the design schema and Sky Orchestrator's subset take. */
export const MOST_CLIMB_M = 120

/** Every height a drawn primitive gives of its own, above zero or not. */
function ownHeights(sketch: WaylineSketch): number[] {
  return sketch.primitives.flatMap((primitive) =>
    primitive.kind === 'route' || primitive.kind === 'points'
      ? primitive.points.flatMap(({ heightM }) => (heightM === undefined ? [] : [heightM]))
      : primitive.heightM === undefined
        ? []
        : [primitive.heightM],
  )
}

function figureRefusal<Missing extends SketchRefusal, NotPositive extends SketchRefusal>(
  value: number | null,
  missing: Missing,
  notPositive: NotPositive,
): Missing | NotPositive | null {
  if (value === null) return missing
  return positive(value) ? null : notPositive
}

/** Every reason the sketch is not a design yet; none means it bakes. */
export function sketchRefusals(sketch: WaylineSketch): SketchRefusal[] {
  return [
    sketch.name.trim() === '' ? 'name_missing' : null,
    sketch.takeoff === null ? 'takeoff_missing' : null,
    figureRefusal(sketch.defaultHeightM, 'height_missing', 'height_not_positive'),
    figureRefusal(sketch.speedMs, 'speed_missing', 'speed_not_positive'),
    figureRefusal(
      sketch.takeoffSecurityHeightM,
      'security_height_missing',
      'security_height_not_positive',
    ),
    sketch.takeoffSecurityHeightM !== null && sketch.takeoffSecurityHeightM > MOST_CLIMB_M
      ? 'security_height_above_max'
      : null,
    ownHeights(sketch).every(positive) ? null : 'primitive_height_not_positive',
  ].filter((refusal): refusal is SketchRefusal => refusal !== null)
}

/** The design the bake takes, or null while a figure it needs is missing or not above 0. */
export function designOf(sketch: WaylineSketch): Design | null {
  const { takeoff, defaultHeightM, speedMs, takeoffSecurityHeightM } = sketch
  if (
    takeoff === null ||
    defaultHeightM === null ||
    speedMs === null ||
    takeoffSecurityHeightM === null ||
    ![defaultHeightM, speedMs, takeoffSecurityHeightM, ...ownHeights(sketch)].every(positive) ||
    takeoffSecurityHeightM > MOST_CLIMB_M
  ) {
    return null
  }
  return {
    takeoff,
    defaultHeightM,
    speedMs,
    takeoffSecurityHeightM,
    finishAction: sketch.finishAction,
    primitives: sketch.primitives,
  }
}

/** The geofence a wayline is designed for: its ring and its ceiling above takeoff. */
export interface Fence {
  readonly polygon: readonly Geodetic[]
  readonly maxHeightM: number
}

/**
 * What a bake breaks of the geofence it is designed for (FR-WAY-01, FR-WAY-06,
 * FR-WAY-08): the takeoff outside it, a waypoint outside it, a leg leaving it (both ends
 * inside is not enough), a height above its ceiling. Each is named by its rule and, when
 * it is about one, its waypoint, as the envelope's are. Decided exactly, on the local
 * frame at `origin`.
 */
export function fenceViolations(baked: Baked, fence: Fence, origin: Geodetic): Violation[] {
  const local = (at: Geodetic): Point => {
    const placed = eastNorth(origin, at)
    return [placed.eastM, placed.northM]
  }
  const ring = fence.polygon.map(local)
  const found: Violation[] = []
  const takeoff = local(baked.referencePoint)
  if (locate(ring, takeoff) !== 'inside') {
    found.push({ rule: 'takeoff_outside_geofence', message: 'the takeoff is outside the geofence' })
  }
  if (baked.takeoffSecurityHeightM > fence.maxHeightM) {
    found.push({
      rule: 'security_height_above_geofence_ceiling',
      message: `the takeoff security height is above the geofence's ceiling of ${String(fence.maxHeightM)} m`,
    })
  }
  let before = takeoff
  for (const waypoint of baked.waypoints) {
    const at = local(waypoint)
    const index = waypoint.index
    if (locate(ring, at) !== 'inside') {
      found.push({
        rule: 'outside_geofence_polygon',
        message: `waypoint ${String(index)} is outside the geofence`,
        waypointIndex: index,
      })
    } else if (locate(ring, before) === 'inside' && legClearance(ring, before, at) === null) {
      found.push({
        rule: 'leg_leaves_geofence',
        message: `the leg into waypoint ${String(index)} leaves the geofence`,
        waypointIndex: index,
      })
    }
    if (waypoint.heightM > fence.maxHeightM) {
      found.push({
        rule: 'above_geofence_ceiling',
        message: `waypoint ${String(index)} is above the geofence's ceiling of ${String(fence.maxHeightM)} m`,
        waypointIndex: index,
      })
    }
    before = at
  }
  return found
}
