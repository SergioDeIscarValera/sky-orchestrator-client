import type { Assignment, Wayline } from '../backend/backend'
import type { Geodetic } from '../geometry/projection'
import { storedFlight } from '../operations/definition'
import type { Site } from './site'
import { flownPath, type FlownPath } from './waylinePath'

/**
 * The planned flight an assignment stores, drawn as the scene draws a flown path (FR-OPS-07): up to its
 * takeoff security height, then its waypoints. Null where the assignment stores no flight, or one the
 * console cannot read, so nothing is drawn in its place.
 */
export function plannedPath(
  assignment: Assignment,
  origin: Geodetic,
  site: Site,
): FlownPath | null {
  const stored = storedFlight(assignment.flight)
  if (!stored.ok || stored.flight === null) return null
  const { flight } = stored
  return flownPath(
    {
      referencePoint: flight.referencePoint,
      takeoffSecurityHeightM: flight.takeoffSecurityHeightM,
      waypoints: flight.waypoints,
    },
    origin,
    site,
  )
}

/**
 * A saved wayline as it flies by its design (FR-WAY-09): from its takeoff straight to its waypoints,
 * with no climb of an operation's before them.
 */
export function designedPath(wayline: Wayline, origin: Geodetic, site: Site): FlownPath {
  return flownPath(
    {
      referencePoint: wayline.takeoff,
      takeoffSecurityHeightM: null,
      waypoints: wayline.waypoints.map(({ position, heightM }) => ({ ...position, heightM })),
    },
    origin,
    site,
  )
}

/**
 * Where an assignment's fleet flies, as the scene draws it (FR-SCN-04): the planned flight it stores,
 * or, until it stores one the console reads, its wayline as designed, so an operation still being
 * defined shows its route. Null when neither is known: a wayline that is not read, or not there.
 */
export function assignedPath(
  assignment: Assignment,
  waylines: readonly Wayline[],
  origin: Geodetic,
  site: Site,
): FlownPath | null {
  const planned = plannedPath(assignment, origin, site)
  if (planned !== null) return planned
  const wayline = waylines.find(({ id }) => id === assignment.waylineId)
  return wayline === undefined ? null : designedPath(wayline, origin, site)
}

/**
 * The takeoff point a fleet's flight takes off from, which its track's heights are above (ADR-0014): the
 * reference point of the planned flight its assignment stores. Null where no assignment of the fleet
 * stores a flight the console reads, so a track is not drawn over a level it does not know.
 */
export function takeoffOf(fleetId: string, assignments: readonly Assignment[]): Geodetic | null {
  const assignment = assignments.find((candidate) => candidate.fleetId === fleetId)
  if (assignment === undefined) return null
  const stored = storedFlight(assignment.flight)
  return stored.ok && stored.flight !== null ? stored.flight.referencePoint : null
}
