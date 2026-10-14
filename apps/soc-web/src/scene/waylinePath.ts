import type { Geodetic } from '../geometry/projection'
import { flatOf } from './groundTool'
import type { Site } from './site'

export type Spot = [number, number, number]

/** What a wayline flies: from where, how high it climbs first, then its waypoints. */
export interface Flown {
  readonly referencePoint: Geodetic
  /** Null where it is not known: the path then rises from the takeoff straight to the first. */
  readonly takeoffSecurityHeightM: number | null
  readonly waypoints: readonly (Geodetic & { readonly heightM: number })[]
}

/** A flown path in the scene: its line, and each waypoint's place, in order. */
export interface FlownPath {
  readonly points: Spot[]
  readonly waypoints: Spot[]
}

/**
 * A wayline in the scene as it flies (FR-WAY-07): up from the takeoff to its climb height,
 * then from waypoint to waypoint, each at its height above the takeoff point's ground
 * (ADR-0014), not above the ground under it. `points` is the path; `waypoints` each one's
 * place, in order.
 */
export function flownPath(flown: Flown, origin: Geodetic, site: Site): FlownPath {
  const takeoff = flatOf(origin, flown.referencePoint)
  const base = site.ground(takeoff.x, takeoff.z)
  const waypoints = flown.waypoints.map((waypoint): Spot => {
    const { x, z } = flatOf(origin, waypoint)
    return [x, base + waypoint.heightM, z]
  })
  return {
    points: [
      [takeoff.x, base, takeoff.z],
      ...(flown.takeoffSecurityHeightM === null
        ? []
        : [[takeoff.x, base + flown.takeoffSecurityHeightM, takeoff.z] satisfies Spot]),
      ...waypoints,
    ],
    waypoints,
  }
}
