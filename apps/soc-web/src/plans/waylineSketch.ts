import type { Design } from '../geometry/bake'
import type { Geodetic } from '../geometry/projection'

/**
 * A wayline being designed (FR-WAY-01 to FR-WAY-06): its name, its takeoff point, its default
 * height and its drawn primitives. A wayline is geometry: its speed, the climb over its takeoff,
 * what it does at the end and its geofence belong to the operation that flies it (M4). A figure
 * is null until given: none is assumed, so nothing flies at a height nobody chose.
 */
export interface WaylineSketch {
  readonly name: string
  readonly takeoff: Geodetic | null
  /** Above the takeoff point (ADR-0014), for every point that gives none of its own. */
  readonly defaultHeightM: number | null
  readonly primitives: Design['primitives']
}

export const EMPTY_SKETCH: WaylineSketch = {
  name: '',
  takeoff: null,
  defaultHeightM: null,
  primitives: [],
}

/** Why a sketch cannot be baked or saved yet, each in a word the designer shows. */
export type SketchRefusal =
  | 'name_missing'
  | 'takeoff_missing'
  | 'height_missing'
  | 'height_not_positive'
  | 'primitive_height_not_positive'
  | 'nothing_drawn'

const positive = (value: number) => Number.isFinite(value) && value > 0

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

/** Every reason the sketch is not a wayline yet; none means it bakes and saves. */
export function sketchRefusals(sketch: WaylineSketch): SketchRefusal[] {
  const height = sketch.defaultHeightM
  return [
    sketch.name.trim() === '' ? 'name_missing' : null,
    sketch.takeoff === null ? 'takeoff_missing' : null,
    height === null ? 'height_missing' : positive(height) ? null : 'height_not_positive',
    ownHeights(sketch).every(positive) ? null : 'primitive_height_not_positive',
    sketch.primitives.length === 0 ? 'nothing_drawn' : null,
  ].filter((refusal): refusal is SketchRefusal => refusal !== null)
}

/** The design the bake takes, or null while the takeoff or a height is missing or not above 0. */
export function designOf(sketch: WaylineSketch): Design | null {
  const { takeoff, defaultHeightM } = sketch
  if (takeoff === null || defaultHeightM === null) return null
  if (![defaultHeightM, ...ownHeights(sketch)].every(positive)) return null
  return { takeoff, defaultHeightM, primitives: sketch.primitives }
}
