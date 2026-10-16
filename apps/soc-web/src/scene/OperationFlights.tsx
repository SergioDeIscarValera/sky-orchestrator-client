import { useMemo } from 'react'

import type { Assignment, Flight } from '../backend/backend'
import type { Geodetic } from '../geometry/projection'
import { FlightPath } from './FlightPath'
import { FlightTrack } from './FlightTrack'
import { plannedPath, takeoffOf } from './plannedFlight'
import { usePalette } from './palette'
import type { Site } from './site'

interface PlannedProps {
  readonly assignments: readonly Assignment[]
  readonly origin: Geodetic
  readonly site: Site
}

/**
 * The planned flights of assignments, each from its stored flight as it flies (FR-OPS-07): drawn as a
 * selected wayline's path is, in the accent colour, over the terrain. An assignment with no flight the
 * console reads draws none.
 */
export function PlannedFlights({ assignments, origin, site }: PlannedProps) {
  const palette = usePalette()
  const planned = useMemo(
    () =>
      assignments.flatMap((assignment) => {
        const path = plannedPath(assignment, origin, site)
        return path === null ? [] : [{ id: assignment.id, path }]
      }),
    [assignments, origin, site],
  )
  return (
    <>
      {planned.map(({ id, path }) => (
        <FlightPath
          key={id}
          name="planned flight"
          path={path}
          colour={palette.accent}
          lineWidth={2.5}
          renderOrder={9}
        />
      ))}
    </>
  )
}

interface TracksProps {
  readonly flights: readonly Flight[]
  readonly assignments: readonly Assignment[]
  readonly origin: Geodetic
  readonly site: Site
}

/**
 * The track of each flight whose fleet has a takeoff point (FR-TEL-05, FR-SCN-04): each one over the
 * takeoff point of the planned flight its fleet is assigned, and in its aircraft's colour.
 */
export function FlightTracks({ flights, assignments, origin, site }: TracksProps) {
  // Each takeoff point is read from a stored flight, so it is kept between renders: a new one would
  // rebuild every track.
  const takeoffs = useMemo(
    () =>
      new Map(
        flights.map((flight): [string, Geodetic | null] => [
          flight.id,
          takeoffOf(flight.fleetId, assignments),
        ]),
      ),
    [flights, assignments],
  )
  return (
    <>
      {flights.map((flight) => {
        const takeoff = takeoffs.get(flight.id) ?? null
        return takeoff === null ? null : (
          <FlightTrack
            key={flight.id}
            flight={flight}
            takeoff={takeoff}
            origin={origin}
            site={site}
          />
        )
      })}
    </>
  )
}
