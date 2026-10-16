import type { Selection } from '../app/router'
import type { Fleet } from '../backend/backend'

/**
 * The fleet a selection is, or the fleet of the aircraft it names. Null for any other selection, and for an
 * aircraft no fleet registers: such an aircraft is in no operation.
 */
export function selectedFleetId(
  selection: Selection | null,
  fleets: readonly Fleet[] | undefined,
): string | null {
  if (selection === null) return null
  if (selection.kind === 'fleet') return selection.fleetId
  if (selection.kind !== 'device') return null
  const fleet = fleets?.find(
    ({ gatewaySn, aircraftSn }) =>
      gatewaySn === selection.gatewaySn && aircraftSn === selection.aircraftSn,
  )
  return fleet?.id ?? null
}
