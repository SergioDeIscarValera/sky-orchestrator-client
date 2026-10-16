import { pathLengthM, type Baked, type BakedWaypoint } from './bake'
import { violations as envelopeViolations, type Envelope, type Violation } from './limits'
import type { Point } from './planar'
import { eastNorth, geodeticAt, type Geodetic } from './projection'
import { distanceM } from './sphere'

/**
 * A wayline flown by an operation (M4, ADR-0009): the wayline's bake, from its takeoff
 * point, at the operation's speed, after climbing to its takeoff security height, finishing
 * as the operation says. A leg longer than the stack's limit is split with 1 % to spare,
 * the height carried along it; every limit of the stack's envelope the flight breaks is
 * told, none fixed silently. What Sky Orchestrator's mission plan takes, field for field,
 * and what the flight file builder writes (FR-WAY-11).
 */

export type FinishAction = 'return_home' | 'hold' | 'land'

export interface FlightSettings {
  /** The organization's position: the local frame's origin (ADR-0014). */
  readonly origin: Geodetic
  /** The operation's height, climbed to over the takeoff before the transit. */
  readonly takeoffSecurityHeightM: number
  /** The speed of the fleet the wayline is assigned to (FR-WAY-10). */
  readonly speedMs: number
  readonly finishAction: FinishAction
  /**
   * The stack's limits, Sky Orchestrator's envelope; null while the console does not
   * know them (FR-LNK-09): then no leg is split and no limit is checked.
   */
  readonly envelope: Envelope | null
}

export interface Flight {
  readonly referencePoint: Geodetic
  readonly takeoffSecurityHeightM: number
  readonly speedMs: number
  readonly finishAction: FinishAction
  readonly waypoints: readonly BakedWaypoint[]
  /** From the reference point through every waypoint, in Sky Orchestrator's metric. */
  readonly distanceM: number
  /** The distance at the flight's speed: the transit up and back are the aircraft's. */
  readonly durationS: number
  readonly violations: readonly Violation[]
}

/** A split leg keeps this share of the stack's limit to spare (ADR-0009). */
export const SPLIT_SLACK = 0.01

interface Stop {
  readonly at: Point
  readonly heightM: number
  /** The bake's own waypoint, kept as it is; a split adds stops without one. */
  readonly baked?: BakedWaypoint
}

/**
 * The stops with every leg longer than the stack's limit, less its slack, split evenly,
 * the height carried along it, measured as Sky Orchestrator measures.
 */
function split(stops: readonly Stop[], start: Stop, settings: FlightSettings): Stop[] {
  if (settings.envelope === null) return [...stops]
  const longest = settings.envelope.maxLegM * (1 - SPLIT_SLACK)
  const geodetic = (at: Point) => geodeticAt(settings.origin, { eastM: at[0], northM: at[1] })
  const out: Stop[] = []
  let before = start
  for (const stop of stops) {
    const leg = distanceM(geodetic(before.at), geodetic(stop.at))
    const pieces = Math.max(1, Math.ceil(leg / longest))
    for (let piece = 1; piece < pieces; piece += 1) {
      const share = piece / pieces
      out.push({
        at: [
          before.at[0] + share * (stop.at[0] - before.at[0]),
          before.at[1] + share * (stop.at[1] - before.at[1]),
        ],
        heightM: before.heightM + share * (stop.heightM - before.heightM),
      })
    }
    out.push(stop)
    before = stop
  }
  return out
}

/** The wayline baked from `takeoff`, flown as the operation's settings say. */
export function planFlight(takeoff: Geodetic, baked: Baked, settings: FlightSettings): Flight {
  const local = (at: Geodetic): Point => {
    const placed = eastNorth(settings.origin, at)
    return [placed.eastM, placed.northM]
  }
  const stops = split(
    baked.waypoints.map((waypoint) => ({
      at: local(waypoint),
      heightM: waypoint.heightM,
      baked: waypoint,
    })),
    { at: local(takeoff), heightM: settings.takeoffSecurityHeightM },
    settings,
  )
  // The bake's points fly as baked; only a split's new points come from the local frame.
  const waypoints = stops.map((stop, index): BakedWaypoint => {
    if (stop.baked !== undefined) return { ...stop.baked, index }
    const place = geodeticAt(settings.origin, { eastM: stop.at[0], northM: stop.at[1] })
    return { index, ...place, heightM: stop.heightM }
  })
  const distance = pathLengthM(takeoff, waypoints)
  const found =
    settings.envelope === null
      ? []
      : envelopeViolations(
          {
            referencePoint: takeoff,
            takeoffSecurityHeightM: settings.takeoffSecurityHeightM,
            speedMs: settings.speedMs,
            waypoints: waypoints.map((w) => ({ index: w.index, position: w, heightM: w.heightM })),
          },
          settings.envelope,
        )
  return {
    referencePoint: takeoff,
    takeoffSecurityHeightM: settings.takeoffSecurityHeightM,
    speedMs: settings.speedMs,
    finishAction: settings.finishAction,
    waypoints,
    distanceM: distance,
    durationS: distance / settings.speedMs,
    violations:
      waypoints.length === 0
        ? [{ rule: 'no_waypoints', message: 'nothing is drawn to fly' }, ...found]
        : found,
  }
}
