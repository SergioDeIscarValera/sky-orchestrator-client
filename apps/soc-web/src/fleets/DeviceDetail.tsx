import { useId, useState } from 'react'

import { useSelect } from '../app/router'
import { ALERT, PRIMARY_BUTTON, UNAVAILABLE } from '../app/styles'
import { useOrganization } from '../organizations/context'
import { useDevices, useFleets, useRegisterFleet } from './data'
import { Details, Gone, ReadOnlyReason, Waiting } from './Details'
import { FleetForm } from './FleetForm'
import { aircraftKey } from '../backend/backend'
import { blankValues, changesFleets } from './form'
import { formatMoment, stackLabel } from './format'
import { PresencePill } from './PresencePill'
import { LiveValues } from '../telemetry/LiveValues'

/** An aircraft one of the organization's stacks announced, and its registration (FR-FLE-02, FR-FLE-03). */
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
  const register = useRegisterFleet()
  const select = useSelect()
  const [registering, setRegistering] = useState(false)
  const heading = useId()
  const reason = useId()

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
  const writes = changesFleets(organization.role)
  const zone = organization.timeZone

  if (registering && fleet === undefined) {
    return (
      <FleetForm
        title={`Register ${device.aircraftSn}`}
        initial={blankValues(device)}
        aircraft={[
          {
            key: aircraftKey(device.gatewaySn, device.aircraftSn),
            label: `${device.aircraftSn} via ${device.stack.name}`,
          },
        ]}
        submitLabel="Register"
        onSubmit={async (draft) => {
          const registered = await register.mutateAsync(draft)
          select({ kind: 'fleet', fleetId: registered.id })
        }}
        onCancel={() => {
          setRegistering(false)
        }}
      />
    )
  }

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
      <LiveValues gatewaySn={device.gatewaySn} aircraftSn={device.aircraftSn} />
      {fleet === undefined ? (
        <div className="mt-5">
          <p className="text-sm">Not in a fleet yet.</p>
          <button
            type="button"
            className={`${PRIMARY_BUTTON} ${UNAVAILABLE} mt-3`}
            aria-disabled={!writes}
            aria-describedby={writes ? undefined : reason}
            onClick={() => {
              if (writes) setRegistering(true)
            }}
          >
            Register as a fleet
          </button>
          {!writes && <ReadOnlyReason id={reason} organization={organization.name} />}
        </div>
      ) : (
        <p className="mt-5 text-sm">
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
        </p>
      )}
    </article>
  )
}
