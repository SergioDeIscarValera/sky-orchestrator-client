import { X } from 'lucide-react'
import { lazy, Suspense } from 'react'

import { Waiting } from '../fleets/Details'
import { DeviceDetail } from '../fleets/DeviceDetail'
import { FleetDetail } from '../fleets/FleetDetail'
import { useSelect, useSelection } from './router'
import { CARD, QUIET_BUTTON } from './styles'

// A plan's detail loads with the plans' geometry, when first shown (NFR-PERF-05).
const GeofenceDetail = lazy(() =>
  import('../plans/GeofenceDetail').then(({ GeofenceDetail: detail }) => ({ default: detail })),
)

/**
 * Whatever is selected, faded in afresh when the selection changes; nothing at all
 * when nothing is, so the scene keeps the whole width.
 */
export function Inspector() {
  const selection = useSelection()
  const select = useSelect()
  if (selection === null) return null
  const key =
    selection.kind === 'fleet'
      ? selection.fleetId
      : selection.kind === 'geofence'
        ? selection.geofenceId
        : `${selection.gatewaySn}/${selection.aircraftSn}`
  return (
    <aside
      aria-label="Inspector"
      className={`${CARD} pointer-events-auto max-h-full min-h-0 self-start overflow-y-auto p-5`}
    >
      <div key={key} className="animate-appear">
        {/* Floated, the close shares its line with whatever the detail shows first: the
            header, a form's title, a wait or a gone selection; the rest takes the width. */}
        <button
          type="button"
          aria-label="Close the inspector"
          className={`${QUIET_BUTTON} float-right -mt-1.5 -mr-2 ml-2 w-9 justify-center px-0`}
          onClick={() => {
            select(null)
          }}
        >
          <X size={16} aria-hidden />
        </button>
        {selection.kind === 'fleet' ? (
          <FleetDetail fleetId={selection.fleetId} />
        ) : selection.kind === 'geofence' ? (
          <Suspense fallback={<Waiting>Loading the geofence…</Waiting>}>
            <GeofenceDetail geofenceId={selection.geofenceId} />
          </Suspense>
        ) : (
          <DeviceDetail gatewaySn={selection.gatewaySn} aircraftSn={selection.aircraftSn} />
        )}
      </div>
    </aside>
  )
}
