import type { Geodetic } from '../geometry/projection'
import type { TelemetrySample } from './sample'
import type { TelemetryStore } from './store'

/**
 * A synthetic flight for development, the scene's checks and the frame-time
 * measurement (`pnpm measure`), never in a production build: idle on the ground
 * for `idleS`, an automatic takeoff straight up at
 * `climbMs`, then a circle around the organization at 15 m/s, sampled at 5 Hz, as
 * SO measured the phone's OSD. The circle is placed with the radii of curvature at
 * the origin, close enough for a check of motion, not a geodesy reference.
 */
export const REPLAY = {
  gatewaySn: 'REPLAYDOCK',
  aircraftSn: 'REPLAYUAV',
  radiusM: 150,
  speedMs: 15,
  heightM: 40,
  rateHz: 5,
  idleS: 2,
  climbMs: 8,
} as const

/** When the replay's circle starts: after standing idle and climbing to its height. */
export const CIRCLING_FROM_S = REPLAY.idleS + REPLAY.heightM / REPLAY.climbMs

/** At most this many aircraft fly the replay, spread evenly round the circle. */
export const MOST_REPLAYED = 4

/** How many aircraft `?replay` asks for: `?replay` one, `?replay=2` two, at most MOST_REPLAYED. */
export function replayCount(value: string | null): number {
  const count = Number(value)
  if (value === null || value === '' || !Number.isInteger(count) || count < 1) return 1
  return Math.min(count, MOST_REPLAYED)
}

/** The replay's aircraft number `aircraft`: the first is REPLAYDOCK's REPLAYUAV, the next end in 2, 3, 4. */
export function replaySerials(aircraft: number): { gatewaySn: string; aircraftSn: string } {
  const suffix = aircraft === 0 ? '' : String(aircraft + 1)
  return { gatewaySn: `${REPLAY.gatewaySn}${suffix}`, aircraftSn: `${REPLAY.aircraftSn}${suffix}` }
}

const SEMI_MAJOR_AXIS_M = 6_378_137
const ECCENTRICITY_SQUARED = 0.00669437999014

/**
 * The replay's sample number `index`, taken `index / rateHz` seconds after
 * `startedAtMs`, of aircraft number `aircraft` of `of`: each takes off from its own
 * point of the circle, a turn divided by `of` from the next.
 */
export function replaySample(
  origin: Geodetic,
  index: number,
  startedAtMs: number,
  aircraft = 0,
  of = 1,
): TelemetrySample {
  const seconds = index / REPLAY.rateHz
  const start = (2 * Math.PI * aircraft) / of
  const travelled = (REPLAY.speedMs * Math.max(0, seconds - CIRCLING_FROM_S)) / REPLAY.radiusM
  const angle = start + travelled
  const idle = seconds < REPLAY.idleS
  const climbing = !idle && seconds < CIRCLING_FROM_S
  const east = REPLAY.radiusM * Math.cos(angle)
  const north = REPLAY.radiusM * Math.sin(angle)
  const latitude = (origin.latitudeDeg * Math.PI) / 180
  const sine = Math.sin(latitude)
  const meridian =
    (SEMI_MAJOR_AXIS_M * (1 - ECCENTRICITY_SQUARED)) /
    (1 - ECCENTRICITY_SQUARED * sine * sine) ** 1.5
  const primeVertical = SEMI_MAJOR_AXIS_M / Math.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
  // Counter-clockwise seen from above: the heading is the tangent, clockwise from north.
  const heading =
    (((Math.atan2(-Math.sin(angle), Math.cos(angle)) * 180) / Math.PI + 540) % 360) - 180
  const takenAtMs = startedAtMs + Math.round(seconds * 1000)
  return {
    stack: 'replay',
    ...replaySerials(aircraft),
    takenAtMs,
    sentAtMs: takenAtMs,
    latitudeDeg: origin.latitudeDeg + ((north / meridian) * 180) / Math.PI,
    longitudeDeg:
      origin.longitudeDeg + ((east / (primeVertical * Math.cos(latitude))) * 180) / Math.PI,
    heightM: idle ? 0 : Math.min(REPLAY.heightM, (seconds - REPLAY.idleS) * REPLAY.climbMs),
    headingDeg: heading,
    // Home is where it took off, its start on the circle: the chord from there.
    homeDistanceM: 2 * REPLAY.radiusM * Math.abs(Math.sin(travelled / 2)),
    batteryPct: Math.max(20, 100 - Math.floor(seconds / 30)),
    satellites: 18,
    gpsQuality: 5,
    // so-gateway's codes: 0 idle, 4 automatic takeoff, 5 wayline.
    modeCode: idle ? 0 : climbing ? 4 : 5,
  }
}

/** Feeds `count` aircraft of the replay into the store at its rate until stopped. */
export function startReplay(store: TelemetryStore, origin: Geodetic, count = 1): () => void {
  const startedAtMs = Date.now()
  let index = 0
  const feed = () => {
    for (let aircraft = 0; aircraft < count; aircraft += 1) {
      // Sent now, as soc-cloud stamps its broadcasts, so the delivery figure reads true.
      const sample = {
        ...replaySample(origin, index, startedAtMs, aircraft, count),
        sentAtMs: Date.now(),
      }
      store.getState().receive(sample, performance.now())
    }
    index += 1
  }
  feed()
  const timer = setInterval(feed, 1000 / REPLAY.rateHz)
  return () => {
    clearInterval(timer)
  }
}
