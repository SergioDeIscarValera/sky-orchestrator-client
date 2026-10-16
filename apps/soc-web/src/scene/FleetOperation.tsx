import { useMemo } from 'react'

import type { Selection } from '../app/router'
import type { Flight } from '../backend/backend'
import { useFleets } from '../fleets/data'
import type { Geodetic } from '../geometry/projection'
import { useFlights } from '../operations/data'
import { useFleetInvolvement, type Involvement } from '../operations/involvement'
import { FlightTracks, PlannedFlights } from './OperationFlights'
import { selectedFleetId } from './selectedFleet'
import type { Site } from './site'

interface Props {
  /** The selection: a fleet, or an aircraft, is what this draws for. */
  readonly selection: Selection | null
  readonly site: Site
  readonly origin: Geodetic
}

const NO_FLIGHTS: readonly Flight[] = []

/**
 * The flight of a selected aircraft, or of its fleet, while its fleet is in an underway operation (FR-SCN-04):
 * the planned flight of that fleet's assignment, the wayline as the operation flies it, and the track of its
 * flight. A selection in no underway operation draws nothing.
 */
export function FleetOperation({ selection, site, origin }: Props) {
  const fleets = useFleets()
  const involvement = useFleetInvolvement(selectedFleetId(selection, fleets.data))
  if (involvement === null) return null
  return <InvolvedFlight involvement={involvement} site={site} origin={origin} />
}

/** The planned flight and the track of the one fleet an underway operation has in it. */
function InvolvedFlight({
  involvement,
  site,
  origin,
}: {
  readonly involvement: Involvement
  readonly site: Site
  readonly origin: Geodetic
}) {
  const { operation, assignment } = involvement
  const flights = useFlights(operation.id)
  const assignments = useMemo(() => [assignment], [assignment])
  const own = useMemo(
    () => (flights.data ?? NO_FLIGHTS).filter(({ fleetId }) => fleetId === assignment.fleetId),
    [flights.data, assignment.fleetId],
  )
  return (
    <group>
      <PlannedFlights assignments={assignments} origin={origin} site={site} />
      <FlightTracks flights={own} assignments={assignments} origin={origin} site={site} />
    </group>
  )
}
