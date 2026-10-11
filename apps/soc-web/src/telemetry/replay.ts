import type { Geodetic } from '../geometry/projection'
import type { TelemetrySample } from './sample'
import type { TelemetryStore } from './store'

/**
 * A synthetic flight for development and the scene's checks, never in a production
 * build: a circle around the organization at 15 m/s, sampled at 5 Hz, as SO
 * measured the phone's OSD. The circle is placed with the radii of curvature at
 * the origin, close enough for a check of motion, not a geodesy reference.
 */
export const REPLAY = {
  gatewaySn: 'REPLAYDOCK',
  aircraftSn: 'REPLAYUAV',
  radiusM: 150,
  speedMs: 15,
  heightM: 40,
  rateHz: 5,
} as const

const SEMI_MAJOR_AXIS_M = 6_378_137
const ECCENTRICITY_SQUARED = 0.00669437999014

/** The replay's sample number `index`, taken `index / rateHz` seconds after `startedAtMs`. */
export function replaySample(
  origin: Geodetic,
  index: number,
  startedAtMs: number,
): TelemetrySample {
  const seconds = index / REPLAY.rateHz
  const angle = (REPLAY.speedMs * seconds) / REPLAY.radiusM
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
    gatewaySn: REPLAY.gatewaySn,
    aircraftSn: REPLAY.aircraftSn,
    takenAtMs,
    sentAtMs: takenAtMs,
    latitudeDeg: origin.latitudeDeg + ((north / meridian) * 180) / Math.PI,
    longitudeDeg:
      origin.longitudeDeg + ((east / (primeVertical * Math.cos(latitude))) * 180) / Math.PI,
    heightM: REPLAY.heightM,
    headingDeg: heading,
    homeDistanceM: REPLAY.radiusM,
    batteryPct: Math.max(20, 100 - Math.floor(seconds / 30)),
    satellites: 18,
    gpsQuality: 5,
    modeCode: 5,
  }
}

/** Feeds the replay into the store at its rate until stopped. */
export function startReplay(store: TelemetryStore, origin: Geodetic): () => void {
  const startedAtMs = Date.now()
  let index = 0
  const feed = () => {
    store.getState().receive(replaySample(origin, index, startedAtMs), performance.now())
    index += 1
  }
  feed()
  const timer = setInterval(feed, 1000 / REPLAY.rateHz)
  return () => {
    clearInterval(timer)
  }
}
