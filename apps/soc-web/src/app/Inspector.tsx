import { DeviceDetail } from '../fleets/DeviceDetail'
import { FleetDetail } from '../fleets/FleetDetail'
import { useSelection } from './router'
import { CARD } from './styles'

/** Whatever is selected, faded in afresh when the selection changes. */
export function Inspector() {
  const selection = useSelection()
  const key =
    selection === null
      ? 'nothing'
      : selection.kind === 'fleet'
        ? selection.fleetId
        : `${selection.gatewaySn}/${selection.aircraftSn}`
  return (
    <aside
      aria-label="Inspector"
      className={`${CARD} pointer-events-auto max-h-full min-h-0 self-start overflow-y-auto p-5`}
    >
      <h2 className="text-sm font-semibold tracking-wider uppercase">Inspector</h2>
      <div key={key} className="animate-appear mt-3">
        {selection === null ? (
          <p className="text-sm">Nothing selected.</p>
        ) : selection.kind === 'fleet' ? (
          <FleetDetail fleetId={selection.fleetId} />
        ) : (
          <DeviceDetail gatewaySn={selection.gatewaySn} aircraftSn={selection.aircraftSn} />
        )}
      </div>
    </aside>
  )
}
