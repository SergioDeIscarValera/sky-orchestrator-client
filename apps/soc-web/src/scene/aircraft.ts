import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  RingGeometry,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { eastNorth, type Geodetic } from '../geometry/projection'
import { freshnessOf, type Freshness } from '../telemetry/freshness'
import type { TelemetrySample } from '../telemetry/sample'
import { IDLE_MODE, type Track } from '../telemetry/store'
import type { ScenePalette } from './palette'
import { FLAT_GROUND, type Ground } from './site'

/** A Mavic Air 2's span, motor to motor across, in metres. */
export const SPAN_M = 0.42
/** However far the camera, an aircraft is drawn at least this many pixels across (FR-SCN-04). */
export const MIN_SPAN_PX = 28
/** A glide between two samples lasts their interval, but never longer than this. */
export const MAX_GLIDE_MS = 1000
/** The casing drawn behind the aircraft is this much larger, so its outline shows. */
export const CASING_SCALE = 1.14

/**
 * The aircraft as the design draws it, built in code from simple shapes, its nose
 * towards -z: a body, two crossed arms and four rotor discs, merged into one
 * geometry so every aircraft is one instance of one draw.
 */
export function createAircraftGeometry(): BufferGeometry {
  const reach = SPAN_M / 2 / Math.SQRT2
  const parts: BufferGeometry[] = [new BoxGeometry(0.1, 0.06, 0.2)]
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    parts.push(new BoxGeometry(SPAN_M, 0.02, 0.025).rotateY(angle))
  }
  for (const [x, z] of [
    [reach, reach],
    [reach, -reach],
    [-reach, reach],
    [-reach, -reach],
  ] as const) {
    parts.push(new CylinderGeometry(0.075, 0.075, 0.01, 20).translate(x, 0.025, z))
  }
  // Every part carries the same attributes, so they merge; the test holds the result.
  const merged = mergeGeometries(parts.map((part) => part.toNonIndexed()))
  for (const part of parts) part.dispose()
  return merged
}

/**
 * The chevron on the aircraft's back, pointing ahead past its body, in the casing's
 * colour against the aircraft's own: where it heads, seen from any side (FR-SCN-04).
 */
export function createNoseGeometry(): BufferGeometry {
  const chevron = new Shape([
    new Vector2(0, 0.32),
    new Vector2(0.1, 0.06),
    new Vector2(0, 0.12),
    new Vector2(-0.1, 0.06),
  ])
  // Drawn on the x-y plane, the chevron pointing up y: laid down, it points ahead, -z.
  return new ExtrudeGeometry(chevron, { depth: 0.012, bevelEnabled: false })
    .rotateX(-Math.PI / 2)
    .translate(0, 0.031, 0)
}

/**
 * The disc under an aircraft that its stalk drops to, flat on the ground, with a
 * wedge on its rim pointing where the aircraft heads: legible from above.
 */
export function createGroundDiscGeometry(): BufferGeometry {
  const radius = SPAN_M / 2
  const wedge = new Shape([
    new Vector2(0, radius * 2.1),
    new Vector2(radius * 0.55, radius * 0.75),
    new Vector2(-radius * 0.55, radius * 0.75),
  ])
  const parts = [new CircleGeometry(radius, 32), new ShapeGeometry(wedge)].map((part) =>
    part.rotateX(-Math.PI / 2),
  )
  const merged = mergeGeometries(parts)
  for (const part of parts) part.dispose()
  return merged
}

/** The casing's material: drawn on its back faces only, so it shows as an outline. */
export function casingMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ side: BackSide })
}

/**
 * Where a sample puts an aircraft in the scene: x east, y up, z south, and its yaw;
 * `groundY` is the ground under it, which its stalk drops to.
 */
export interface Placement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yawRad: number
  readonly groundY: number
}

/**
 * The sample in the scene's frame (ADR-0014): the ground at the takeoff point,
 * `takeoffY`, plus the height above it, never under the ground beneath the
 * aircraft. Idle, or with its height unknown, it stands on that ground. DJI's
 * heading is clockwise from north, the scene's yaw counter-clockwise about up from
 * a nose towards north.
 */
export function placement(
  origin: Geodetic,
  sample: TelemetrySample,
  ground: Ground = FLAT_GROUND,
  takeoffY = 0,
): Placement | null {
  if (sample.latitudeDeg === null || sample.longitudeDeg === null) return null
  const { eastM, northM } = eastNorth(origin, {
    latitudeDeg: sample.latitudeDeg,
    longitudeDeg: sample.longitudeDeg,
  })
  const groundY = ground(eastM, -northM)
  const standing = sample.modeCode === IDLE_MODE || sample.heightM === null
  return {
    x: eastM,
    y: standing ? groundY : Math.max(groundY, takeoffY + sample.heightM),
    z: -northM,
    yawRad: sample.headingDeg === null ? 0 : -MathUtils.degToRad(sample.headingDeg),
    groundY,
  }
}

/** The ground's height at the track's takeoff point, which its heights are above. */
export function takeoffLevel(track: Track, origin: Geodetic, ground: Ground = FLAT_GROUND): number {
  if (track.takeoff === null) return 0
  const { eastM, northM } = eastNorth(origin, track.takeoff)
  return ground(eastM, -northM)
}

/** The turn from one yaw to another the short way round, in (-π, π]. */
function shortTurn(from: number, to: number): number {
  const turn = MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI
  return turn === -Math.PI ? Math.PI : turn
}

export interface Drawn {
  readonly placement: Placement
  readonly freshness: Freshness
  /** Still gliding towards the latest sample: the scene keeps drawing frames until it is not. */
  readonly gliding: boolean
}

/**
 * Where to draw an aircraft at `now` (FR-TEL-02). From the latest sample's arrival
 * it glides from the previous sample to the latest, over their interval, and stops
 * there: motion is interpolated between samples, never extrapolated past the latest.
 * Lost, the latest sample is where it was last known, which the scene marks on the
 * ground only, never as a current position.
 */
export function drawnAt(
  track: Track,
  origin: Geodetic,
  now: number,
  thresholds: { readonly telemetryStaleAfterMs: number; readonly telemetryLostAfterMs: number },
  ground: Ground = FLAT_GROUND,
): Drawn | null {
  const freshness = freshnessOf(Math.max(0, now - track.latest.receivedAt), thresholds)
  const takeoff = takeoffLevel(track, origin, ground)
  const latest = placement(origin, track.latest.sample, ground, takeoff)
  if (latest === null) return null
  if (freshness === 'lost') return { placement: latest, freshness, gliding: false }
  const previous =
    track.previous === null ? null : placement(origin, track.previous.sample, ground, takeoff)
  if (previous === null || track.previous === null) {
    return { placement: latest, freshness, gliding: false }
  }
  const glideMs = Math.min(track.latest.receivedAt - track.previous.receivedAt, MAX_GLIDE_MS)
  const share = glideMs <= 0 ? 1 : MathUtils.clamp((now - track.latest.receivedAt) / glideMs, 0, 1)
  const x = MathUtils.lerp(previous.x, latest.x, share)
  const z = MathUtils.lerp(previous.z, latest.z, share)
  // The ground between two samples is not the line between their grounds: a ridge
  // crossed between them is under the glide, which stays above it.
  const groundY = ground(x, z)
  return {
    placement: {
      x,
      y: Math.max(groundY, MathUtils.lerp(previous.y, latest.y, share)),
      z,
      yawRad: previous.yawRad + shortTurn(previous.yawRad, latest.yawRad) * share,
      groundY,
    },
    freshness,
    gliding: share < 1,
  }
}

/**
 * How much to enlarge an aircraft `distanceM` from a camera of `fovDeg` on a view
 * `viewportPx` tall, so it spans at least MIN_SPAN_PX: 1 once close enough to be
 * that size anyway.
 */
export function screenScale(distanceM: number, fovDeg: number, viewportPx: number): number {
  const metresPerPixel =
    (2 * distanceM * Math.tan(MathUtils.degToRad(fovDeg) / 2)) / Math.max(1, viewportPx)
  return Math.max(1, (MIN_SPAN_PX * metresPerPixel) / SPAN_M)
}

/** The instanced parts every aircraft of the organization is drawn with: five draws, six with a selection. */
export interface AircraftParts {
  readonly group: Group
  readonly bodies: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly casings: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  /** The chevrons that point each aircraft's heading. */
  readonly noses: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly discs: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly stalks: LineSegments<BufferGeometry, LineBasicMaterial>
  /** The soft ring on the ground under the selected aircraft. */
  readonly ring: Mesh<BufferGeometry, MeshBasicMaterial>
  /** The aircraft each body instance draws, by `aircraftKey`, for picking. */
  readonly keys: string[]
}

/** Drawn over the terrain they lie on even where far depths lose precision. */
const ON_GROUND = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 } as const

export function createAircraftParts(capacity: number): AircraftParts {
  const shape = createAircraftGeometry()
  const bodies = new InstancedMesh(shape, new MeshBasicMaterial(), capacity)
  bodies.name = 'aircraft'
  const casings = new InstancedMesh(shape, casingMaterial(), capacity)
  casings.name = 'aircraft-casing'
  const noses = new InstancedMesh(createNoseGeometry(), new MeshBasicMaterial(), capacity)
  noses.name = 'aircraft-nose'
  const discs = new InstancedMesh(
    createGroundDiscGeometry(),
    new MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, ...ON_GROUND }),
    capacity,
  )
  discs.name = 'aircraft-disc'
  const stalkPositions = new Float32BufferAttribute(new Float32Array(capacity * 6), 3)
  stalkPositions.setUsage(DynamicDrawUsage)
  const stalks = new LineSegments(
    new BufferGeometry().setAttribute('position', stalkPositions),
    new LineBasicMaterial(),
  )
  stalks.name = 'aircraft-stalk'
  const ring = new Mesh(
    new RingGeometry(SPAN_M * 0.75, SPAN_M * 1.05, 48).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, ...ON_GROUND }),
  )
  ring.name = 'aircraft-selection'
  ring.visible = false
  const group = new Group()
  group.name = 'aircraft-parts'
  for (const part of [bodies, casings, noses, discs, stalks, ring]) {
    // Instances spread over the whole site; the geometry's own bounds would cull them wrongly.
    part.frustumCulled = false
    group.add(part)
  }
  // Only an aircraft is picked: its nose, the discs, the stalks and the ring do not take the pointer.
  for (const part of [noses, discs, stalks, ring]) part.raycast = () => undefined
  for (const mesh of [bodies, casings, noses, discs]) mesh.count = 0
  stalks.geometry.setDrawRange(0, 0)
  return { group, bodies, casings, noses, discs, stalks, ring, keys: [] }
}

export function paintAircraft(parts: AircraftParts, palette: ScenePalette): void {
  parts.casings.material.color.set(palette.casing)
  parts.noses.material.color.set(palette.casing)
  parts.stalks.material.color.set(palette.casing)
  parts.ring.material.color.set(palette.accent)
}

/** How far a stale aircraft's colour fades towards the muted one: still its own, plainly old. */
export const STALE_FADE = 0.55

const pose = new Object3D()
const tint = new Color()
const muted = new Color()
const heading = new Quaternion()
const UP = new Vector3(0, 1, 0)
const normal = new Vector3()

/**
 * Lays `object` flat on the ground at (x, z), `radius` across: tilted to the slope
 * under that span and lifted to the higher of its centre and the span's mean, so a
 * disc in a hollow does not sink into its sides.
 */
export function restOnGround(
  object: Object3D,
  ground: Ground,
  x: number,
  z: number,
  radius: number,
) {
  const centre = ground(x, z)
  const west = ground(x - radius, z)
  const east = ground(x + radius, z)
  const north = ground(x, z - radius)
  const south = ground(x, z + radius)
  normal.set((west - east) / (2 * radius), 1, (north - south) / (2 * radius)).normalize()
  object.quaternion.setFromUnitVectors(UP, normal)
  // A hair above the ground, more for a larger disc, which a coarser terrain is drawn under.
  const lift = 0.02 + radius * 0.02
  object.position.set(x, Math.max(centre, (west + east + north + south) / 4) + lift, z)
}

/** One aircraft to draw: where and how fresh it is, and its colour's index (`useAircraftColours`). */
export interface ToDraw {
  readonly key: string
  readonly drawn: Drawn
  readonly colour: number
}

/**
 * Writes this frame's aircraft into the parts. Live, an aircraft is its own colour;
 * stale, that colour faded towards the muted one; lost, only a muted disc where it
 * was last known. Its nose and its disc's wedge point where it heads. Each is
 * enlarged to stay MIN_SPAN_PX across from wherever the camera is.
 */
export function writeAircraft(
  parts: AircraftParts,
  aircraft: readonly ToDraw[],
  camera: { readonly x: number; readonly y: number; readonly z: number },
  fovDeg: number,
  viewportPx: number,
  palette: ScenePalette,
  selected: string | null = null,
  ground: Ground = FLAT_GROUND,
): void {
  const stalk = parts.stalks.geometry.getAttribute('position') as Float32BufferAttribute
  parts.ring.visible = false
  muted.set(palette.gridMajor)
  let bodies = 0
  let discs = 0
  let stalks = 0
  parts.keys.length = 0
  for (const { key, drawn, colour } of aircraft) {
    if (discs >= parts.discs.instanceMatrix.count) break
    const { x, y, z, yawRad, groundY } = drawn.placement
    const scale = screenScale(
      Math.hypot(camera.x - x, camera.y - y, camera.z - z),
      fovDeg,
      viewportPx,
    )
    const current = drawn.freshness !== 'lost'
    const own = palette.aircraft[colour % Math.max(1, palette.aircraft.length)] ?? palette.accent
    tint.set(own)
    if (drawn.freshness === 'stale') tint.lerp(muted, STALE_FADE)
    if (!current) tint.copy(muted)

    restOnGround(pose, ground, x, z, (SPAN_M / 2) * scale)
    // Turned about the ground's own up, so the wedge points the heading on a slope too.
    pose.quaternion.multiply(heading.setFromAxisAngle(UP, yawRad))
    pose.scale.setScalar(scale)
    pose.updateMatrix()
    parts.discs.setMatrixAt(discs, pose.matrix)
    parts.discs.setColorAt(discs, tint)
    discs += 1
    if (key === selected) {
      restOnGround(parts.ring, ground, x, z, SPAN_M * 1.05 * scale)
      parts.ring.position.y += 0.01
      parts.ring.scale.setScalar(scale)
      parts.ring.visible = true
    }
    if (!current) continue

    pose.position.set(x, y + 0.04 * scale, z)
    pose.rotation.set(0, yawRad, 0)
    pose.updateMatrix()
    parts.bodies.setMatrixAt(bodies, pose.matrix)
    parts.bodies.setColorAt(bodies, tint)
    parts.noses.setMatrixAt(bodies, pose.matrix)
    pose.scale.setScalar(scale * CASING_SCALE)
    pose.updateMatrix()
    parts.casings.setMatrixAt(bodies, pose.matrix)
    parts.keys.push(key)
    bodies += 1

    if (y > groundY) {
      stalk.setXYZ(stalks * 2, x, groundY, z)
      stalk.setXYZ(stalks * 2 + 1, x, y, z)
      stalks += 1
    }
  }
  parts.bodies.count = bodies
  parts.casings.count = bodies
  parts.noses.count = bodies
  parts.discs.count = discs
  for (const mesh of [parts.bodies, parts.casings, parts.noses, parts.discs]) {
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  }
  stalk.needsUpdate = true
  parts.stalks.geometry.setDrawRange(0, stalks * 2)
  // A ray tests an instanced mesh's bounding sphere first, which three computes once:
  // computed again here, an aircraft that has flown away from it can still be picked.
  parts.bodies.computeBoundingSphere()
  parts.casings.computeBoundingSphere()
}

export function disposeAircraft(parts: AircraftParts): void {
  parts.bodies.geometry.dispose()
  parts.noses.geometry.dispose()
  parts.discs.geometry.dispose()
  parts.stalks.geometry.dispose()
  parts.ring.geometry.dispose()
  for (const part of [
    parts.bodies,
    parts.casings,
    parts.noses,
    parts.discs,
    parts.stalks,
    parts.ring,
  ]) {
    part.material.dispose()
  }
  parts.bodies.dispose()
  parts.casings.dispose()
  parts.noses.dispose()
  parts.discs.dispose()
}
