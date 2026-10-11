import { useId } from 'react'

import { useSelect } from '../app/router'
import { ALERT } from '../app/styles'
import { useOrganization } from '../organizations/context'
import { useDevices, useFleets } from './data'
import { Details, Gone, Waiting } from './Details'
import { formatMoment, stackLabel } from './format'
import { PresencePill } from './PresencePill'

/** An aircraft one of the organization's stacks announced (FR-FLE-02). */
export function DeviceDetail({
  gatewaySn,
  aircraftSn,
}: {
  readonly gatewaySn: string
  readonly aircraftSn: string
}) {
  const { organization } = useOrganization()
  const devices = useDevices()
  const fleets = useFleets()
  const select = useSelect()
  const heading = useId()

  if (devices.isPending) return <Waiting>Loading the aircraft…</Waiting>
  if (devices.isError) {
    return (
      <p role="alert" className={ALERT}>
        {devices.error.message}
      </p>
    )
  }
  const device = devices.data.find(
    (seen) => seen.gatewaySn === gatewaySn && seen.aircraftSn === aircraftSn,
  )
  if (device === undefined) {
    return (
      <Gone>
        No stack of {organization.name} has announced aircraft {aircraftSn} through gateway{' '}
        {gatewaySn}.
      </Gone>
    )
  }
  const fleet = fleets.data?.find(
    (registered) => registered.gatewaySn === gatewaySn && registered.aircraftSn === aircraftSn,
  )
  const zone = organization.timeZone

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={heading} className="text-lg font-semibold break-words">
            {device.aircraftSn}
          </h3>
          <p className="text-muted text-sm">Seen on the wire</p>
        </div>
        <PresencePill device={device} />
      </div>
      <Details
        title="On the wire"
        rows={[
          ['Gateway', device.gatewaySn],
          ['Wire model', device.wireModel],
          ['Stack', stackLabel(device)],
          ['Firmware', device.firmwareVersion ?? 'Not reported yet'],
          ['First seen', formatMoment(device.firstSeenAt, zone)],
          ['Last seen', formatMoment(device.lastSeenAt, zone)],
        ]}
      />
      <p className="mt-5 text-sm">
        {fleet === undefined ? (
          'Not in a fleet yet.'
        ) : (
          <>
            In fleet{' '}
            <button
              type="button"
              className="text-primary-emphasis font-semibold underline-offset-2 hover:underline"
              onClick={() => {
                select({ kind: 'fleet', fleetId: fleet.id })
              }}
            >
              {fleet.name}
            </button>
            .
          </>
        )}
      </p>
    </article>
  )
}
