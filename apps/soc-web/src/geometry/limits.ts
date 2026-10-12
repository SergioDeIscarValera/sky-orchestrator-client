import type { Geodetic } from './projection'
import { distanceM } from './sphere'

/**
 * Sky Orchestrator's flight envelope, checked as it checks it (FR-WAY-08, ADR-0009): the
 * same limits in the same order, in its metric, a value exactly at a limit passing, each
 * violation named by Sky Orchestrator's code, as libs/soc-geo's `soc_geo.limits`. The
 * bake reports these; the services check them again, and Sky Orchestrator's own verdict
 * is still shown beside SOC's.
 */

/** A stack's limits, under so-wayline's configuration keys. */
export interface Envelope {
  readonly geofenceCenter: Geodetic
  readonly geofenceRadiusM: number
  readonly maxHeightM: number
  readonly maxHomeDistanceM: number
  readonly maxLegM: number
  readonly maxTransitM: number
  readonly maxTotalDistanceM: number
  readonly maxWaypoints: number
  readonly maxHorizontalSpeedMs: number
}

export interface PlanWaypoint {
  readonly index: number
  readonly position: Geodetic
  readonly heightM: number
  readonly speedMs?: number
}

export interface Plan {
  readonly referencePoint: Geodetic
  readonly takeoffSecurityHeightM: number
  readonly speedMs: number
  readonly waypoints: readonly PlanWaypoint[]
}

/** A limit broken, by Sky Orchestrator's code, with the waypoint when it is one. */
export interface Violation {
  readonly rule: string
  readonly message: string
  readonly waypointIndex?: number
}

const m = (value: number) => `${value.toFixed(1)} m`
const g = (value: number) => String(Number(value.toPrecision(6)))

/**
 * Every limit `plan` breaks, in Sky Orchestrator's order. The transit and every point's
 * distance from home need the takeoff position, checked only when it is given.
 */
export function violations(
  plan: Plan,
  envelope: Envelope,
  options: { readonly transitionalSpeedMs?: number; readonly expectedTakeoff?: Geodetic } = {},
): Violation[] {
  const found: Violation[] = []
  const { waypoints } = plan
  if (waypoints.length > envelope.maxWaypoints) {
    found.push({
      rule: 'too_many_waypoints',
      message: `the wayline holds ${String(waypoints.length)} waypoints; max_waypoints is ${String(envelope.maxWaypoints)}`,
    })
  }
  if (plan.takeoffSecurityHeightM > envelope.maxHeightM) {
    found.push({
      rule: 'takeoff_security_height_above_max',
      message: `the takeoff security height ${m(plan.takeoffSecurityHeightM)} is above max_height_m ${m(envelope.maxHeightM)}`,
    })
  }
  for (const w of waypoints) {
    if (w.heightM > envelope.maxHeightM) {
      found.push({
        rule: 'height_above_max',
        message: `waypoint ${String(w.index)} is at ${m(w.heightM)}, above max_height_m ${m(envelope.maxHeightM)}`,
        waypointIndex: w.index,
      })
    }
  }
  const points: (readonly [number | undefined, Geodetic])[] = [
    [undefined, plan.referencePoint],
    ...waypoints.map((w) => [w.index, w.position] as const),
  ]
  for (const [index, point] of points) {
    const distance = distanceM(envelope.geofenceCenter, point)
    if (distance > envelope.geofenceRadiusM) {
      const what = index === undefined ? 'the reference point' : `waypoint ${String(index)}`
      found.push({
        rule: 'outside_geofence',
        message: `${what} is ${m(distance)} from the geofence centre; the radius is ${m(envelope.geofenceRadiusM)}`,
        ...(index === undefined ? {} : { waypointIndex: index }),
      })
    }
  }
  let previous = plan.referencePoint
  let total = 0
  for (const w of waypoints) {
    const leg = distanceM(previous, w.position)
    total += leg
    if (leg > envelope.maxLegM) {
      const origin = w.index === 0 ? 'the reference point' : `waypoint ${String(w.index - 1)}`
      found.push({
        rule: 'leg_too_long',
        message: `the leg from ${origin} to waypoint ${String(w.index)} is ${m(leg)}; max_leg_m is ${m(envelope.maxLegM)}`,
        waypointIndex: w.index,
      })
    }
    previous = w.position
  }
  if (total > envelope.maxTotalDistanceM) {
    found.push({
      rule: 'total_distance_too_long',
      message: `the route is ${m(total)} from the reference point; max_total_distance_m is ${m(envelope.maxTotalDistanceM)}`,
    })
  }
  const limit = envelope.maxHorizontalSpeedMs
  const speeds: (readonly [number | undefined, string, number])[] = [
    [undefined, 'the wayline speed', plan.speedMs],
    ...(options.transitionalSpeedMs === undefined
      ? []
      : [[undefined, 'the WPML transitional speed', options.transitionalSpeedMs] as const]),
    ...waypoints.flatMap((w) =>
      w.speedMs === undefined
        ? []
        : [[w.index, `the leg into waypoint ${String(w.index)}`, w.speedMs] as const],
    ),
  ]
  for (const [index, what, value] of speeds) {
    if (value > limit) {
      found.push({
        rule: 'speed_above_max',
        message: `${what} is ${g(value)} m/s; max_horizontal_speed_ms is ${g(limit)}`,
        ...(index === undefined ? {} : { waypointIndex: index }),
      })
    }
  }
  const takeoff = options.expectedTakeoff
  if (takeoff !== undefined) {
    const transit = distanceM(takeoff, plan.referencePoint)
    if (transit > envelope.maxTransitM) {
      found.push({
        rule: 'transit_too_long',
        message: `the transit from the expected takeoff position is ${m(transit)}; max_transit_m is ${m(envelope.maxTransitM)}`,
      })
    }
    for (const [index, point] of points) {
      const distance = distanceM(takeoff, point)
      if (distance > envelope.maxHomeDistanceM) {
        const what = index === undefined ? 'the reference point' : `waypoint ${String(index)}`
        found.push({
          rule: 'home_distance_too_far',
          message: `${what} is ${m(distance)} from the expected takeoff position; max_home_distance_m is ${m(envelope.maxHomeDistanceM)}`,
          ...(index === undefined ? {} : { waypointIndex: index }),
        })
      }
    }
  }
  return found
}
