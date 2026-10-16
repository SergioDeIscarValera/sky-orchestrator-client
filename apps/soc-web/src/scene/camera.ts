import CameraControls from 'camera-controls'
import { Box3, MathUtils, Spherical, Vector3 } from 'three'

import type { SceneBox } from './commands'
import type { Site } from './site'

const { ACTION } = CameraControls

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
  /**
   * How far the view is shifted right, in metres across the camera, from looking
   * straight at the target: the target, which the camera orbits, then sits that far
   * left of the screen's middle. Zero unless framing beside the cards.
   */
  readonly sideM?: number
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

/**
 * How far the camera at `offset` from `target`, shifted `sideM` across the view, is
 * above lowestCameraHeightM() over its ground.
 */
function clearanceOf(site: Site, target: Vector3, offset: Spherical, sideM = 0): number {
  const away = new Vector3().setFromSpherical(offset)
  const camera = away.clone().add(target)
  if (sideM !== 0) camera.addScaledVector(rightOf(away), sideM)
  return camera.y - site.ground(camera.x, camera.z) - lowestCameraHeightM()
}

/** The view's right, level, for a camera `away` from its target. */
function rightOf(away: Vector3): Vector3 {
  const right = new Vector3(0, 1, 0).cross(away)
  return right.lengthSq() === 0 ? right.set(1, 0, 0) : right.normalize()
}

/**
 * The polar angle closest to the offset's own that keeps the camera
 * lowestCameraHeightM() over the ground beneath it (FR-SCN-03): the camera looks
 * more steeply down until it is clear of the terrain behind it. Looking straight
 * down, it is above its target, which is never under the ground, so one is found.
 */
export function clearPolarAngle(site: Site, target: Vector3, offset: Spherical, sideM = 0): number {
  const clearance = (trial: Spherical) => clearanceOf(site, target, trial, sideM)
  if (clearance(offset) >= -TOLERANCE_M) return offset.phi
  const trial = offset.clone()
  let under = offset.phi
  let over = Math.max(0, offset.phi - PITCH_STEP_RAD)
  while (over > 0 && clearance(trial.set(trial.radius, over, trial.theta)) < 0) {
    under = over
    over = Math.max(0, over - PITCH_STEP_RAD)
  }
  for (let bisection = 0; bisection < BISECTIONS; bisection += 1) {
    const middle = (under + over) / 2
    if (clearance(trial.set(trial.radius, middle, trial.theta)) < 0) under = middle
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
  const phi = clearPolarAngle(site, target, offset, controls.getFocalOffset(new Vector3(), true).x)
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
  const sideM = pose.sideM ?? 0
  offset.phi = clearPolarAngle(site, target, offset, sideM)
  const position = new Vector3().setFromSpherical(offset).add(target)
  void controls.setFocalOffset(sideM, 0, 0, transition)
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
 * How far to shift the view right, in metres at `distanceM`, so the target sits in the
 * middle of the view the cards leave free rather than the screen's: as many pixels as
 * the free view's middle is left of the screen's.
 */
export function sideShiftM(
  distanceM: number,
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered,
): number {
  const metresPerPixel =
    (2 * distanceM * Math.tan(MathUtils.degToRad(FIELD_OF_VIEW_DEG) / 2)) /
    Math.max(1, viewportPx.height)
  const free = viewportPx.width - covered.leftPx - covered.rightPx
  const offCentrePx = free >= SMALLEST_FREE_PX ? (covered.rightPx - covered.leftPx) / 2 : 0
  return offCentrePx * metresPerPixel
}

/**
 * The pose that frames `subject` in the middle of the view the cards leave free:
 * the camera keeps the angle the user chose and comes to FRAME_DISTANCE_M of the
 * subject, which it then orbits; the view is shifted aside instead of the target.
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
  return {
    target: subject.clone(),
    position: subject.clone().addScaledVector(direction, FRAME_DISTANCE_M),
    sideM: sideShiftM(FRAME_DISTANCE_M, viewportPx, covered),
  }
}

/** The width the cards leave free, in pixels: the whole view when it is too narrow to leave any room. */
function freeWidthPx(
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered,
): number {
  const free = viewportPx.width - covered.leftPx - covered.rightPx
  return free >= SMALLEST_FREE_PX ? free : viewportPx.width
}

/**
 * The half-angle, in radians, of the view the cards leave free: the camera's vertical half-angle, or
 * its horizontal one at the free width's aspect where that is narrower. Never zero, so a view with no
 * size still has a finite distance to fit from; flyTo then holds the pose within the camera's limits.
 */
function freeHalfAngleRad(
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered,
): number {
  const vertical = MathUtils.degToRad(FIELD_OF_VIEW_DEG / 2)
  const aspect = freeWidthPx(viewportPx, covered) / Math.max(1, viewportPx.height)
  return Math.max(MathUtils.degToRad(1), Math.min(vertical, Math.atan(Math.tan(vertical) * aspect)))
}

/**
 * How far the camera stands from the centre of a bounding sphere of `radiusM` for the whole sphere to lie
 * in the view the cards leave free (FR-SCN-05): the radius over the sine of that view's narrower
 * half-angle, and never closer than FRAME_DISTANCE_M.
 */
export function fitDistanceM(
  radiusM: number,
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered = coveredBy(false),
): number {
  return Math.max(FRAME_DISTANCE_M, radiusM / Math.sin(freeHalfAngleRad(viewportPx, covered)))
}

/**
 * The pose that fits a box in the view the cards leave free (FR-SCN-05): the camera keeps the angle the
 * user chose and stands `fitDistanceM` from the box's centre, which it orbits, with the view shifted aside
 * as `framePose` shifts it. The view holds the box's bounding sphere, so it holds each corner of the box.
 */
export function fitPose(
  box: SceneBox,
  camera: { readonly position: Vector3; readonly target: Vector3 },
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered = coveredBy(false),
): Pose {
  const min = new Vector3(box.min.x, box.min.y, box.min.z)
  const max = new Vector3(box.max.x, box.max.y, box.max.z)
  const centre = min.clone().add(max).multiplyScalar(0.5)
  const distanceM = fitDistanceM(max.distanceTo(min) / 2, viewportPx, covered)
  const direction = camera.position.clone().sub(camera.target)
  if (direction.lengthSq() === 0) direction.set(0, 1, 1)
  direction.normalize()
  return {
    target: centre,
    position: centre.clone().addScaledVector(direction, distanceM),
    sideM: sideShiftM(distanceM, viewportPx, covered),
  }
}

/** Within this distance of its framing pose, a camera flying to a pinned subject has arrived. */
export const ARRIVED_M = 0.5
/** A camera flight lasts at most this long (the design's motion rules); then it follows. */
export const LONGEST_FLIGHT_MS = 1200

/**
 * Moves the camera with a pinned subject from `from` to `to` (FR-SCN-05): the target,
 * which the camera orbits, moves by the subject's motion, and nothing else does, so
 * the user may orbit it and come closer or farther while it flies. The view's side
 * shift follows the distance, so the subject stays in the middle of the free view.
 */
export function follow(
  controls: CameraControls,
  from: Vector3,
  to: Vector3,
  site: Site,
  viewportPx: { readonly width: number; readonly height: number },
  covered: Covered,
): void {
  const target = controls.getTarget(new Vector3(), true).add(to.clone().sub(from))
  void controls.moveTo(target.x, target.y, target.z, false)
  void controls.setFocalOffset(sideShiftM(controls.distance, viewportPx, covered), 0, 0, false)
  keepAboveTerrain(controls, site)
}

/** Panning the map, by mouse or by touch, lets go of a pinned subject; orbiting and zooming do not. */
export function unpinsOn(action: number): boolean {
  const panning =
    ACTION.TRUCK |
    ACTION.SCREEN_PAN |
    ACTION.OFFSET |
    ACTION.TOUCH_TRUCK |
    ACTION.TOUCH_SCREEN_PAN |
    ACTION.TOUCH_OFFSET |
    ACTION.TOUCH_DOLLY_TRUCK |
    ACTION.TOUCH_DOLLY_SCREEN_PAN |
    ACTION.TOUCH_DOLLY_OFFSET |
    ACTION.TOUCH_ZOOM_TRUCK |
    ACTION.TOUCH_ZOOM_SCREEN_PAN |
    ACTION.TOUCH_ZOOM_OFFSET
  return (action & panning) !== 0
}
