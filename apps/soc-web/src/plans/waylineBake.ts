import { bake, type Baked } from '../geometry/bake'
import type { Geodetic } from '../geometry/projection'
import { designOf, type WaylineSketch } from './waylineSketch'

interface Settings {
  /** The scene's origin: the local frame the bake works on (ADR-0014). */
  readonly origin: Geodetic
  readonly maxArcSpacingM: number
}

let last: {
  readonly sketch: WaylineSketch
  readonly settings: Settings
  readonly baked: Baked | null
} | null = null

/**
 * The sketch baked live (FR-WAY-07), as the designer's form and the scene both show it, or
 * null while it is not a design yet (`sketchRefusals`): the same sketch and settings give
 * the same result, computed once.
 */
export function bakeSketch(sketch: WaylineSketch, settings: Settings): Baked | null {
  if (
    last !== null &&
    last.sketch === sketch &&
    last.settings.origin === settings.origin &&
    last.settings.maxArcSpacingM === settings.maxArcSpacingM
  ) {
    return last.baked
  }
  const design = designOf(sketch)
  const baked = design === null ? null : bake(design, settings)
  last = { sketch, settings, baked }
  return baked
}
