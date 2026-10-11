import type CameraControls from 'camera-controls'
import { Box3, MathUtils, Spherical, Vector3 } from 'three'

import type { Site } from './site'

export const FIELD_OF_VIEW_DEG = 30
export const OVERVIEW_PITCH_DEG = 50
export const MIN_DISTANCE_M = 20
export const LOWEST_PITCH_DEG = 10
export const CEILING_M = 1500
const OVERVIEW_MARGIN = 1.15
const SMOOTH_TIME_S = 0.25

export interface Pose {
  readonly position: Vector3
  readonly target: Vector3
}

/** The whole site in view, looking north at the design's pitch (FR-SCN-03). */
export function overviewPose(site: Site): Pose {
  const distance =
    (site.halfSizeM * OVERVIEW_MARGIN) / Math.tan(MathUtils.degToRad(FIELD_OF_VIEW_DEG / 2))
  const pitch = MathUtils.degToRad(OVERVIEW_PITCH_DEG)
  return {
    position: new Vector3(0, distance * Math.sin(pitch), distance * Math.cos(pitch)),
    target: new Vector3(0, 0, 0),
  }
}

/**
 * Limits that keep the camera above the ground and over the site under any
 * input: the target stays on the site, the camera never looks from below the
 * lowest pitch, and never comes closer than the minimum distance, so its
 * height is at least MIN_DISTANCE_M × sin(LOWEST_PITCH_DEG).
 */
export function configureControls(
  controls: CameraControls,
  site: Site,
  reducedMotion: boolean,
): void {
  controls.minDistance = MIN_DISTANCE_M
  controls.maxDistance = overviewPose(site).position.length() * 1.5
  controls.minPolarAngle = 0
  controls.maxPolarAngle = MathUtils.degToRad(90 - LOWEST_PITCH_DEG)
  controls.infinityDolly = false
  controls.boundaryEnclosesCamera = false
  controls.setBoundary(boundary(site))
  controls.smoothTime = reducedMotion ? 0 : SMOOTH_TIME_S
  controls.draggingSmoothTime = reducedMotion ? 0 : SMOOTH_TIME_S / 2
}

export function lowestCameraHeightM(): number {
  return MIN_DISTANCE_M * Math.sin(MathUtils.degToRad(LOWEST_PITCH_DEG))
}

/**
 * The only way the console moves the camera itself. camera-controls applies its
 * limits to the user's gestures but not to setLookAt, so a pose is brought
 * within them here first.
 */
export function flyTo(
  controls: CameraControls,
  pose: Pose,
  site: Site,
  transition: boolean,
): Promise<void> {
  const target = boundary(site).clampPoint(pose.target, new Vector3())
  const offset = new Spherical().setFromVector3(pose.position.clone().sub(target))
  offset.phi = MathUtils.clamp(offset.phi, controls.minPolarAngle, controls.maxPolarAngle)
  offset.radius = MathUtils.clamp(offset.radius, controls.minDistance, controls.maxDistance)
  const position = new Vector3().setFromSpherical(offset).add(target)
  return controls.setLookAt(
    position.x,
    position.y,
    position.z,
    target.x,
    target.y,
    target.z,
    transition,
  )
}

function boundary(site: Site): Box3 {
  return new Box3(
    new Vector3(-site.halfSizeM, 0, -site.halfSizeM),
    new Vector3(site.halfSizeM, CEILING_M, site.halfSizeM),
  )
}

/** How far from an aircraft the camera stops when it flies to frame it. */
export const FRAME_DISTANCE_M = 140
/** The inspector's width and its gutters, which the framed aircraft keeps clear of. */
export const INSPECTOR_SPAN_PX = 360 + 32

/**
 * The pose that frames `subject` beside the inspector: the camera keeps the angle
 * the user chose and comes to FRAME_DISTANCE_M, with its target moved right by half
 * the inspector, so the subject sits in the middle of the view the inspector leaves.
 */
export function framePose(
  subject: Vector3,
  camera: { readonly position: Vector3; readonly target: Vector3 },
  viewportPx: { readonly width: number; readonly height: number },
): Pose {
  const direction = camera.position.clone().sub(camera.target)
  if (direction.lengthSq() === 0) direction.set(0, 1, 1)
  direction.normalize()
  const right = new Vector3(0, 1, 0).cross(direction).normalize()
  const metresPerPixel =
    (2 * FRAME_DISTANCE_M * Math.tan(MathUtils.degToRad(FIELD_OF_VIEW_DEG) / 2)) /
    Math.max(1, viewportPx.height)
  const shiftM =
    viewportPx.width > INSPECTOR_SPAN_PX * 2 ? (INSPECTOR_SPAN_PX / 2) * metresPerPixel : 0
  const target = subject.clone().addScaledVector(right, shiftM)
  return { target, position: target.clone().addScaledVector(direction, FRAME_DISTANCE_M) }
}
