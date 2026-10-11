import { FIELD_OF_VIEW_DEG } from './camera'

/**
 * The rendering rules of ADR-0016 and the design system: frames only when
 * something changed (NFR-RES-01), the pixel ratio capped at 1.5, the low-power
 * GPU, no post-processing, and no tone mapping, so every colour on screen is
 * its token's (NFR-UX-01).
 */
export const CANVAS_SETTINGS = {
  frameloop: 'demand',
  flat: true,
  dpr: [1, 1.5],
  gl: { powerPreference: 'low-power', antialias: true },
  camera: { fov: FIELD_OF_VIEW_DEG, near: 2, far: 20000 },
} as const
