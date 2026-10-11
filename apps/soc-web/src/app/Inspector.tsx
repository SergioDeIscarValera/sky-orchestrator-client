import { X } from 'lucide-react'

import { DeviceDetail } from '../fleets/DeviceDetail'
import { FleetDetail } from '../fleets/FleetDetail'
import { useSelect, useSelection } from './router'
import { CARD, QUIET_BUTTON } from './styles'

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
      : `${selection.gatewaySn}/${selection.aircraftSn}`
  return (
    <aside
      aria-label="Inspector"
      className={`${CARD} pointer-events-auto max-h-full min-h-0 self-start overflow-y-auto p-5`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wider uppercase">Inspector</h2>
        <button
          type="button"
          aria-label="Close the inspector"
          className={QUIET_BUTTON}
          onClick={() => {
            select(null)
          }}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div key={key} className="animate-appear mt-3">
        {selection.kind === 'fleet' ? (
          <FleetDetail fleetId={selection.fleetId} />
        ) : (
          <DeviceDetail gatewaySn={selection.gatewaySn} aircraftSn={selection.aircraftSn} />
        )}
      </div>
    </aside>
  )
}
