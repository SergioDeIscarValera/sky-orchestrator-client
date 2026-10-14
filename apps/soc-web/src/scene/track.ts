import type { TrackPoint } from '../backend/backend'
import { eastNorth, type Geodetic } from '../geometry/projection'
import type { TelemetrySample } from '../telemetry/sample'
import { placement } from './aircraft'
import type { Ground } from './site'

/** A vertex of a track in the scene: x east, y up, z south, in metres (ADR-0014). */
export type Vertex = readonly [x: number, y: number, z: number]

/**
 * The frame a flight's track is drawn in: the scene's origin, its ground, and the takeoff its heights
 * are above.
 */
export interface TrackFrame {
  readonly origin: Geodetic
  readonly ground: Ground
  readonly takeoff: Geodetic
}

/**
 * The live samples a track continues with: those the telemetry store holds that the stored track does
 * not, which are the ones taken after its last point, in time order. Nothing before the last stored point
 * is appended (FR-TEL-05), and the track ends at the newest sample, never past it (FR-TEL-02).
 */
export function liveAfter(
  stored: readonly TrackPoint[],
  live: readonly TelemetrySample[],
): TelemetrySample[] {
  let last = Number.NEGATIVE_INFINITY
  for (const point of stored) last = Math.max(last, Date.parse(point.sampledAt))
  return live.filter((sample) => sample.takenAtMs > last).sort((a, b) => a.takenAtMs - b.takenAtMs)
}

/**
 * The vertices of a flight's track: its stored samples in time order, each over the ground at its
 * takeoff point plus its height and never under the ground beneath it, as the aircraft is placed
 * (ADR-0014); then the live samples after the last stored one, each where the scene draws the
 * aircraft at that sample. `stored` is in time order, as `track()` answers it.
 */
export function trackSpots(
  frame: TrackFrame,
  stored: readonly TrackPoint[],
  live: readonly TelemetrySample[],
): Vertex[] {
  const takeoff = eastNorth(frame.origin, frame.takeoff)
  const takeoffY = frame.ground(takeoff.eastM, -takeoff.northM)
  const spots: Vertex[] = []
  for (const point of stored) {
    const { eastM, northM } = eastNorth(frame.origin, point.position)
    const x = eastM
    const z = -northM
    spots.push([x, Math.max(frame.ground(x, z), takeoffY + point.heightM), z])
  }
  for (const sample of liveAfter(stored, live)) {
    const drawn = placement(frame.origin, sample, frame.ground, takeoffY)
    if (drawn !== null) spots.push([drawn.x, drawn.y, drawn.z])
  }
  return spots
}
