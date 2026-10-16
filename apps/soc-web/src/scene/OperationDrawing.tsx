import type { Assignment, Flight } from '../backend/backend'
import type { Geodetic } from '../geometry/projection'
import { useAssignments, useFlights, useOperation } from '../operations/data'
import { useGeofences } from '../plans/data'
import { FlightTracks, PlannedFlights } from './OperationFlights'
import { GeofenceOutline } from './GeofenceOutline'
import type { Site } from './site'

interface Props {
  /** The operation the scene draws, or null when none is selected: then nothing is drawn. */
  readonly operationId: string | null
  readonly site: Site
  readonly origin: Geodetic
}

const NO_ASSIGNMENTS: readonly Assignment[] = []
const NO_FLIGHTS: readonly Flight[] = []

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
  const geofence = geofences.data?.find(({ id }) => id === operation.data?.geofenceId)
  const planned = assignments.data ?? NO_ASSIGNMENTS

  return (
    <group>
      {geofence !== undefined && (
        <GeofenceOutline geofence={geofence} origin={origin} site={site} chosen />
      )}
      <PlannedFlights assignments={planned} origin={origin} site={site} />
      <FlightTracks
        flights={flights.data ?? NO_FLIGHTS}
        assignments={planned}
        origin={origin}
        site={site}
      />
    </group>
  )
}
