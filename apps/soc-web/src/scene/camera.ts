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
 * lowest pitch, and never comes closer than the minimum distance, so over flat
 * ground its height is at least lowestCameraHeightM(). Over a terrain,
 * keepAboveTerrain holds the same height over the ground beneath the camera.
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

/** The finest step the pitch is raised in, before the last step is narrowed down. */
const PITCH_STEP_RAD = MathUtils.degToRad(0.25)
const BISECTIONS = 8
const TOLERANCE_M = 1e-6

/** How far the camera at `offset` from `target` is above lowestCameraHeightM() over its ground. */
function clearanceOf(site: Site, target: Vector3, offset: Spherical): number {
  const camera = new Vector3().setFromSpherical(offset).add(target)
  return camera.y - site.ground(camera.x, camera.z) - lowestCameraHeightM()
}

/**
 * The polar angle closest to the offset's own that keeps the camera
 * lowestCameraHeightM() over the ground beneath it (FR-SCN-03): the camera looks
 * more steeply down until it is clear of the terrain behind it. Looking straight
 * down, it is above its target, which is never under the ground, so one is found.
 */
export function clearPolarAngle(site: Site, target: Vector3, offset: Spherical): number {
  if (clearanceOf(site, target, offset) >= -TOLERANCE_M) return offset.phi
  const trial = offset.clone()
  let under = offset.phi
  let over = Math.max(0, offset.phi - PITCH_STEP_RAD)
  while (over > 0 && clearanceOf(site, target, trial.set(trial.radius, over, trial.theta)) < 0) {
    under = over
    over = Math.max(0, over - PITCH_STEP_RAD)
  }
  for (let bisection = 0; bisection < BISECTIONS; bisection += 1) {
    const middle = (under + over) / 2
    if (clearanceOf(site, target, trial.set(trial.radius, middle, trial.theta)) < 0) under = middle
    else over = middle
  }
  return over
}

/**
 * Holds the camera's end pose over the terrain: its target never under the
 * ground, and the camera lowestCameraHeightM() over the ground beneath it. On
 * camera-controls' `control` event, which comes after the user's input and before
 * the camera moves, and after the map tools' dolly.
 */
export function keepAboveTerrain(controls: CameraControls, site: Site): void {
  const transition = controls.smoothTime > 0
  const target = controls.getTarget(new Vector3(), true)
  const ground = site.ground(target.x, target.z)
  if (target.y < ground) {
    target.y = ground
    void controls.moveTo(target.x, target.y, target.z, transition)
  }
  const offset = controls.getSpherical(new Spherical(), true)
  const phi = clearPolarAngle(site, target, offset)
  if (phi < offset.phi) void controls.rotatePolarTo(phi, transition)
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
  target.y = Math.max(target.y, site.ground(target.x, target.z))
  const offset = new Spherical().setFromVector3(pose.position.clone().sub(target))
  offset.phi = MathUtils.clamp(offset.phi, controls.minPolarAngle, controls.maxPolarAngle)
  offset.radius = MathUtils.clamp(offset.radius, controls.minDistance, controls.maxDistance)
  offset.phi = clearPolarAngle(site, target, offset)
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

/** Where the target may go: over the site, from its lowest ground to CEILING_M over its highest. */
function boundary(site: Site): Box3 {
  return new Box3(
    new Vector3(-site.halfSizeM, Math.min(0, site.lowestM), -site.halfSizeM),
    new Vector3(site.halfSizeM, Math.max(0, site.highestM) + CEILING_M, site.halfSizeM),
  )
}

/** How far from an aircraft the camera stops when it flies to frame it. */
export const FRAME_DISTANCE_M = 140
/** What the cards over the scene cover from its sides, gutters included (the shell's layout). */
export const RAIL_SPAN_PX = 16 + 60 + 16
export const PANEL_SPAN_PX = RAIL_SPAN_PX + 384 + 16
export const INSPECTOR_SPAN_PX = 360 + 32
/** Narrower than this, the free view is too small to frame in: the whole view is used. */
const SMALLEST_FREE_PX = 320

/** The pixels the cards cover on the left and on the right of the scene. */
export interface Covered {
  readonly leftPx: number
  readonly rightPx: number
}

/** The rail, or the open panel beside it, on the left; the inspector on the right. */
export function coveredBy(panelOpen: boolean): Covered {
  return { leftPx: panelOpen ? PANEL_SPAN_PX : RAIL_SPAN_PX, rightPx: INSPECTOR_SPAN_PX }
}

/**
 * The pose that frames `subject` in the middle of the view the cards leave free:
 * the camera keeps the angle the user chose and comes to FRAME_DISTANCE_M, its
 * target moved sideways by as much as the free view's middle is off the screen's.
 */
export function framePose(
  subject: Vector3,
  camera: { readonly position: Vector3; readonly target: Vector3 },
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered = coveredBy(false),
): Pose {
  const direction = camera.position.clone().sub(camera.target)
  if (direction.lengthSq() === 0) direction.set(0, 1, 1)
  direction.normalize()
  const right = new Vector3(0, 1, 0).cross(direction).normalize()
  const metresPerPixel =
    (2 * FRAME_DISTANCE_M * Math.tan(MathUtils.degToRad(FIELD_OF_VIEW_DEG) / 2)) /
    Math.max(1, viewportPx.height)
  const free = viewportPx.width - covered.leftPx - covered.rightPx
  // The free view's middle sits this far left of the screen's; the target goes as far right.
  const offCentrePx = free >= SMALLEST_FREE_PX ? (covered.rightPx - covered.leftPx) / 2 : 0
  const shiftM = offCentrePx * metresPerPixel
  const target = subject.clone().addScaledVector(right, shiftM)
  return { target, position: target.clone().addScaledVector(direction, FRAME_DISTANCE_M) }
}

/** Within this distance of its framing pose, a camera flying to a pinned subject has arrived. */
export const ARRIVED_M = 0.5
/** A camera flight lasts at most this long (the design's motion rules); then it follows. */
export const LONGEST_FLIGHT_MS = 1200

/**
 * Moves the camera with a pinned subject from `from` to `to`: its target and its
 * position shift by the subject's motion, so the user's angle and distance, and
 * where the subject sits in the view, stay as they were (FR-SCN-05). Through
 * flyTo, so within the camera's limits.
 */
export function follow(
  controls: CameraControls,
  from: Vector3,
  to: Vector3,
  site: Site,
): Promise<void> {
  const shift = to.clone().sub(from)
  return flyTo(
    controls,
    {
      position: controls.getPosition(new Vector3()).add(shift),
      target: controls.getTarget(new Vector3()).add(shift),
    },
    site,
    false,
  )
}
