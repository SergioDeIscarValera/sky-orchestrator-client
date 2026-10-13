import { ALERT } from '../app/styles'
import { Details } from '../fleets/Details'
import { formatDuration } from '../fleets/format'
import type { Flight } from '../geometry/flight'
import type { Violation } from '../geometry/limits'
import { formatLength } from '../plans/format'

/**
 * The flight the assignment stores (FR-OPS-01, FR-WAY-11): its figures, and every problem it
 * has, the envelope's and the geofence's, each named by its rule and its waypoint.
 */
export function OperationFlight({
  flight,
  problems,
  error,
}: {
  /** The stored flight, or null while none is planned. */
  readonly flight: Flight | null
  readonly problems: readonly Violation[]
  /** Why the stored flight cannot be read, if it cannot. */
  readonly error: string | null
}) {
  const figures: (readonly [string, string])[] =
    flight === null
      ? []
      : [
          ['Waypoints', String(flight.waypoints.length)],
          ['Distance', formatLength(flight.distanceM)],
          ['Duration', formatDuration(Math.round(flight.durationS))],
        ]
  return (
    <Details title="Flight" rows={figures}>
      {flight === null && error === null && <p className="text-muted mt-2 text-sm">Not planned</p>}
      {error !== null && (
        <p role="alert" className={`${ALERT} mt-3`}>
          {error}
        </p>
      )}
      {problems.length > 0 && (
        <ul aria-label="Problems" className="mt-3 flex flex-col gap-2">
          {problems.map((problem, index) => (
            <li key={`${problem.rule}-${String(index)}`} className={ALERT}>
              <p className="font-semibold">
                {problem.rule}
                {problem.waypointIndex === undefined
                  ? ''
                  : ` · waypoint ${String(problem.waypointIndex)}`}
              </p>
              <p>{problem.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Details>
  )
}
