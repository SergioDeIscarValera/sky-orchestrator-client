import { useId } from 'react'

import { useOrganization } from '../organizations/context'
import { ALERT } from '../app/styles'
import { useAircraftModels, useDevices, useFleets } from './data'
import { Details, Gone, Waiting } from './Details'
import { formatDuration, formatMoment, stackLabel } from './format'
import { ModelSpecs } from './ModelSpecs'
import { PresencePill } from './PresencePill'

/** A fleet's identity, what its stack last said of it, and its model (FR-FLE-04). */
export function FleetDetail({ fleetId }: { readonly fleetId: string }) {
  const { organization } = useOrganization()
  const fleets = useFleets()
  const devices = useDevices()
  const models = useAircraftModels()
  const heading = useId()

  if (fleets.isPending) return <Waiting>Loading the fleet…</Waiting>
  if (fleets.isError) {
    return (
      <p role="alert" className={ALERT}>
        {fleets.error.message}
      </p>
    )
  }
  const fleet = fleets.data.find(({ id }) => id === fleetId)
  if (fleet === undefined) {
    return (
      <Gone>
        {organization.name} has no live fleet with this link: it may have been retired, or belong to
        another organization.
      </Gone>
    )
  }
  const device = devices.data?.find(
    ({ gatewaySn, aircraftSn }) => gatewaySn === fleet.gatewaySn && aircraftSn === fleet.aircraftSn,
  )
  const model = models.data?.find(({ model: key }) => key === fleet.model)
  const zone = organization.timeZone

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={heading} className="text-lg font-semibold break-words">
            {fleet.name}
          </h3>
          <p className="text-muted text-sm">{model?.displayName ?? fleet.model}</p>
        </div>
        {device !== undefined && <PresencePill device={device} />}
      </div>
      <Details
        title="Identity"
        rows={[
          ['Airframe serial', fleet.airframeSerial],
          ['Controller serial', fleet.controllerSerial ?? 'Not recorded'],
          ['Aircraft', fleet.aircraftSn],
          ['Gateway', fleet.gatewaySn],
          ['Flight time before SOC', formatDuration(fleet.flightTimeBeforeSocS)],
          ['Registered', formatMoment(fleet.createdAt, zone)],
        ]}
      />
      {device !== undefined && (
        <Details
          title="On the wire"
          rows={[
            ['Stack', stackLabel(device)],
            ['Wire model', device.wireModel],
            ['Firmware', device.firmwareVersion ?? 'Not reported yet'],
            ['Last seen', formatMoment(device.lastSeenAt, zone)],
          ]}
        />
      )}
      {model !== undefined ? (
        <ModelSpecs model={model} />
      ) : (
        <p className="text-muted mt-5 text-sm">
          {models.isPending ? 'Loading the catalogue…' : `${fleet.model} is not in the catalogue.`}
        </p>
      )}
    </article>
  )
}
