import type { Flight } from '../geometry/flight'
import type { Violation } from '../geometry/limits'
import { legClearance, locate, type Point } from '../geometry/planar'
import { eastNorth, type Geodetic } from '../geometry/projection'

/** An operation's geofence: its ring and its ceiling above the takeoff (FR-GEO-01). */
export interface Fence {
  readonly polygon: readonly Geodetic[]
  readonly maxHeightM: number
}

/**
 * What a flight breaks of its operation's geofence (FR-WAY-01, FR-WAY-06, FR-WAY-08): the
 * takeoff outside it, a waypoint outside it, a leg leaving it (both ends inside is not
 * enough), a height above its ceiling, the climb above it. Each is named by its rule and, when
 * it is about one, its waypoint, as the envelope's are. Decided exactly, on the local frame at
 * `origin`. The operation's preflight checks it (M4).
 */
export function fenceViolations(baked: Flight, fence: Fence, origin: Geodetic): Violation[] {
  const local = (at: Geodetic): Point => {
    const placed = eastNorth(origin, at)
    return [placed.eastM, placed.northM]
  }
  const ring = fence.polygon.map(local)
  const found: Violation[] = []
  const takeoff = local(baked.referencePoint)
  if (locate(ring, takeoff) !== 'inside') {
    found.push({ rule: 'takeoff_outside_geofence', message: 'the takeoff is outside the geofence' })
  }
  if (baked.takeoffSecurityHeightM > fence.maxHeightM) {
    found.push({
      rule: 'security_height_above_geofence_ceiling',
      message: `the takeoff security height is above the geofence's ceiling of ${String(fence.maxHeightM)} m`,
    })
  }
  let before = takeoff
  for (const waypoint of baked.waypoints) {
    const at = local(waypoint)
    const index = waypoint.index
    if (locate(ring, at) !== 'inside') {
      found.push({
        rule: 'outside_geofence_polygon',
        message: `waypoint ${String(index)} is outside the geofence`,
        waypointIndex: index,
      })
    } else if (locate(ring, before) === 'inside' && legClearance(ring, before, at) === null) {
      found.push({
        rule: 'leg_leaves_geofence',
        message: `the leg into waypoint ${String(index)} leaves the geofence`,
        waypointIndex: index,
      })
    }
    if (waypoint.heightM > fence.maxHeightM) {
      found.push({
        rule: 'above_geofence_ceiling',
        message: `waypoint ${String(index)} is above the geofence's ceiling of ${String(fence.maxHeightM)} m`,
        waypointIndex: index,
      })
    }
    before = at
  }
  return found
}
