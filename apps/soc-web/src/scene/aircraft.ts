import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { eastNorth, type Geodetic } from '../geometry/projection'
import { freshnessOf, type Freshness } from '../telemetry/freshness'
import type { TelemetrySample } from '../telemetry/sample'
import type { Track } from '../telemetry/store'
import type { ScenePalette } from './palette'

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

/** The disc under an aircraft that its stalk drops to, flat on the ground. */
export function createGroundDiscGeometry(): BufferGeometry {
  return new CircleGeometry(SPAN_M / 2, 32).rotateX(-Math.PI / 2)
}

/** The casing's material: drawn on its back faces only, so it shows as an outline. */
export function casingMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ side: BackSide })
}

/** Where a sample puts an aircraft in the scene: x east, y up, z south, and its yaw. */
export interface Placement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yawRad: number
}

/**
 * The sample in the scene's frame (ADR-0014). The flat ground is the takeoff
 * point's level, so a height below it, or unknown, draws on the ground; the
 * inspector says which. DJI's heading is clockwise from north, the scene's yaw
 * counter-clockwise about up from a nose towards north.
 */
export function placement(origin: Geodetic, sample: TelemetrySample): Placement | null {
  if (sample.latitudeDeg === null || sample.longitudeDeg === null) return null
  const { eastM, northM } = eastNorth(origin, {
    latitudeDeg: sample.latitudeDeg,
    longitudeDeg: sample.longitudeDeg,
  })
  return {
    x: eastM,
    y: Math.max(0, sample.heightM ?? 0),
    z: -northM,
    yawRad: sample.headingDeg === null ? 0 : -MathUtils.degToRad(sample.headingDeg),
  }
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
): Drawn | null {
  const freshness = freshnessOf(Math.max(0, now - track.latest.receivedAt), thresholds)
  const latest = placement(origin, track.latest.sample)
  if (latest === null) return null
  if (freshness === 'lost') return { placement: latest, freshness, gliding: false }
  const previous = track.previous === null ? null : placement(origin, track.previous.sample)
  if (previous === null || track.previous === null) {
    return { placement: latest, freshness, gliding: false }
  }
  const glideMs = Math.min(track.latest.receivedAt - track.previous.receivedAt, MAX_GLIDE_MS)
  const share = glideMs <= 0 ? 1 : MathUtils.clamp((now - track.latest.receivedAt) / glideMs, 0, 1)
  return {
    placement: {
      x: MathUtils.lerp(previous.x, latest.x, share),
      y: MathUtils.lerp(previous.y, latest.y, share),
      z: MathUtils.lerp(previous.z, latest.z, share),
      yawRad: previous.yawRad + shortTurn(previous.yawRad, latest.yawRad) * share,
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

/** The instanced parts every aircraft of the organization is drawn with: four draws, five with a selection. */
export interface AircraftParts {
  readonly group: Group
  readonly bodies: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly casings: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly discs: InstancedMesh<BufferGeometry, MeshBasicMaterial>
  readonly stalks: LineSegments<BufferGeometry, LineBasicMaterial>
  /** The soft ring on the ground under the selected aircraft. */
  readonly ring: Mesh<BufferGeometry, MeshBasicMaterial>
  /** The aircraft each body instance draws, by `aircraftKey`, for picking. */
  readonly keys: string[]
}

export function createAircraftParts(capacity: number): AircraftParts {
  const shape = createAircraftGeometry()
  const bodies = new InstancedMesh(shape, new MeshBasicMaterial(), capacity)
  bodies.name = 'aircraft'
  const casings = new InstancedMesh(shape, casingMaterial(), capacity)
  casings.name = 'aircraft-casing'
  const discs = new InstancedMesh(
    createGroundDiscGeometry(),
    new MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
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
    new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
  )
  ring.name = 'aircraft-selection'
  ring.visible = false
  const group = new Group()
  group.name = 'aircraft-parts'
  for (const part of [bodies, casings, discs, stalks, ring]) {
    // Instances spread over the whole site; the geometry's own bounds would cull them wrongly.
    part.frustumCulled = false
    group.add(part)
  }
  // Only an aircraft is picked: the discs, the stalks and the ring do not take the pointer.
  for (const part of [discs, stalks, ring]) part.raycast = () => undefined
  for (const mesh of [bodies, casings, discs]) mesh.count = 0
  stalks.geometry.setDrawRange(0, 0)
  return { group, bodies, casings, discs, stalks, ring, keys: [] }
}

export function paintAircraft(parts: AircraftParts, palette: ScenePalette): void {
  parts.casings.material.color.set(palette.casing)
  parts.stalks.material.color.set(palette.casing)
  parts.ring.material.color.set(palette.accent)
}

const pose = new Object3D()
const tint = new Color()

/**
 * Writes this frame's aircraft into the parts. Live, an aircraft is the accent;
 * stale, the muted colour; lost, only a muted disc where it was last known. Each
 * is enlarged to stay MIN_SPAN_PX across from wherever the camera is.
 */
export function writeAircraft(
  parts: AircraftParts,
  aircraft: readonly { readonly key: string; readonly drawn: Drawn }[],
  camera: { readonly x: number; readonly y: number; readonly z: number },
  fovDeg: number,
  viewportPx: number,
  palette: ScenePalette,
  selected: string | null = null,
): void {
  const stalk = parts.stalks.geometry.getAttribute('position') as Float32BufferAttribute
  parts.ring.visible = false
  let bodies = 0
  let discs = 0
  let stalks = 0
  parts.keys.length = 0
  for (const { key, drawn } of aircraft) {
    if (discs >= parts.discs.instanceMatrix.count) break
    const { x, y, z, yawRad } = drawn.placement
    const scale = screenScale(
      Math.hypot(camera.x - x, camera.y - y, camera.z - z),
      fovDeg,
      viewportPx,
    )
    const current = drawn.freshness !== 'lost'
    const colour = drawn.freshness === 'live' ? palette.accent : palette.gridMajor

    pose.position.set(x, 0.02, z)
    pose.rotation.set(0, 0, 0)
    pose.scale.setScalar(scale)
    pose.updateMatrix()
    parts.discs.setMatrixAt(discs, pose.matrix)
    parts.discs.setColorAt(discs, tint.set(current ? colour : palette.gridMajor))
    discs += 1
    if (key === selected) {
      parts.ring.position.set(x, 0.03, z)
      parts.ring.scale.setScalar(scale)
      parts.ring.visible = true
    }
    if (!current) continue

    pose.position.set(x, y + 0.04 * scale, z)
    pose.rotation.set(0, yawRad, 0)
    pose.updateMatrix()
    parts.bodies.setMatrixAt(bodies, pose.matrix)
    parts.bodies.setColorAt(bodies, tint.set(colour))
    pose.scale.setScalar(scale * CASING_SCALE)
    pose.updateMatrix()
    parts.casings.setMatrixAt(bodies, pose.matrix)
    parts.keys.push(key)
    bodies += 1

    if (y > 0) {
      stalk.setXYZ(stalks * 2, x, 0, z)
      stalk.setXYZ(stalks * 2 + 1, x, y, z)
      stalks += 1
    }
  }
  parts.bodies.count = bodies
  parts.casings.count = bodies
  parts.discs.count = discs
  for (const mesh of [parts.bodies, parts.casings, parts.discs]) {
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
  parts.discs.geometry.dispose()
  parts.stalks.geometry.dispose()
  parts.ring.geometry.dispose()
  for (const part of [parts.bodies, parts.casings, parts.discs, parts.stalks, parts.ring]) {
    part.material.dispose()
  }
  parts.bodies.dispose()
  parts.casings.dispose()
  parts.discs.dispose()
}
