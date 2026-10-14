import { useMemo } from 'react'

import type { Geodetic } from '../geometry/projection'
import { useAssignments, useFlights, useOperation } from '../operations/data'
import { useGeofences } from '../plans/data'
import { FlightPath } from './FlightPath'
import { FlightTrack } from './FlightTrack'
import { GeofenceOutline } from './GeofenceOutline'
import { plannedPath, takeoffOf } from './plannedFlight'
import { usePalette } from './palette'
import type { Site } from './site'

interface Props {
  /** The operation the scene draws, or null when none is selected: then nothing is drawn. */
  readonly operationId: string | null
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The selected operation in the scene (FR-SCN-04): its geofence, drawn as a chosen one is; its
 * planned flight from each assignment's stored flight, as a selected wayline's path is; and the track
 * of each of its flights. The queries run only while an operation is selected.
 */
export function OperationDrawing({ operationId, site, origin }: Props) {
  if (operationId === null) return null
  return <OperationOn operationId={operationId} site={site} origin={origin} />
}

function OperationOn({
  operationId,
  site,
  origin,
}: {
  readonly operationId: string
  readonly site: Site
  readonly origin: Geodetic
}) {
  const operation = useOperation(operationId)
  const assignments = useAssignments(operationId)
  const flights = useFlights(operationId)
  const geofences = useGeofences()
  const palette = usePalette()
  const geofence = geofences.data?.find(({ id }) => id === operation.data?.geofenceId)
  const planned = useMemo(
    () =>
      (assignments.data ?? []).flatMap((assignment) => {
        const path = plannedPath(assignment, origin, site)
        return path === null ? [] : [{ id: assignment.id, path }]
      }),
    [assignments.data, origin, site],
  )
  const takeoffs = useMemo(
    () =>
      new Map(
        (flights.data ?? []).map((flight): [string, Geodetic | null] => [
          flight.id,
          takeoffOf(flight.fleetId, assignments.data ?? []),
        ]),
      ),
    [flights.data, assignments.data],
  )

  return (
    <group>
      {geofence !== undefined && (
        <GeofenceOutline geofence={geofence} origin={origin} site={site} chosen />
      )}
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
      {(flights.data ?? []).map((flight) => {
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
    </group>
  )
}
