import { bake, type Baked } from '../geometry/bake'
import type { Violation } from '../geometry/limits'
import type { Geodetic } from '../geometry/projection'
import { designOf, fenceViolations, type Fence, type WaylineSketch } from './waylineSketch'

/** The stack's envelope reaches the console with the operations (FR-LNK-09, M4): until then, none. */
export const STACK_ENVELOPE = null

/** A sketch baked, and everything it breaks: the stack's envelope's, then its geofence's. */
export interface Judged {
  /** Null while the sketch is not a design yet (`sketchRefusals`). */
  readonly baked: Baked | null
  readonly violations: readonly Violation[]
}

interface Settings {
  /** The scene's origin: the local frame the bake works on (ADR-0014). */
  readonly origin: Geodetic
  readonly maxArcSpacingM: number
  /** The geofence the wayline is designed for, or none. */
  readonly fence: Fence | null
}

let last: {
  readonly sketch: WaylineSketch
  readonly settings: Settings
  readonly judged: Judged
} | null = null

/**
 * The sketch baked live (FR-WAY-07), as the designer's form and the scene both show it:
 * the same sketch and settings give the same result, computed once.
 */
export function judge(sketch: WaylineSketch, settings: Settings): Judged {
  if (
    last !== null &&
    last.sketch === sketch &&
    last.settings.origin === settings.origin &&
    last.settings.maxArcSpacingM === settings.maxArcSpacingM &&
    last.settings.fence === settings.fence
  ) {
    return last.judged
  }
  const design = designOf(sketch)
  let judged: Judged = { baked: null, violations: [] }
  if (design !== null) {
    const baked = bake(design, {
      origin: settings.origin,
      maxArcSpacingM: settings.maxArcSpacingM,
      envelope: STACK_ENVELOPE,
    })
    const fenced =
      settings.fence === null ? [] : fenceViolations(baked, settings.fence, settings.origin)
    judged = { baked, violations: [...baked.violations, ...fenced] }
  }
  last = { sketch, settings, judged }
  return judged
}
