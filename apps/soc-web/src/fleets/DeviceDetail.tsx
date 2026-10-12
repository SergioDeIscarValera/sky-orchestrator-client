import { Plus } from 'lucide-react'
import { useId } from 'react'

import { useForm, useSelect } from '../app/router'
import { ALERT, UNAVAILABLE } from '../app/styles'
import { useOrganization } from '../organizations/context'
import { useDevices, useFleets, useRegisterFleet } from './data'
import { Details, Gone, ReadOnlyReason, Waiting } from './Details'
import { FleetForm } from './FleetForm'
import { aircraftKey } from '../backend/backend'
import { blankValues, changesFleets } from './form'
import { formatMoment, stackLabel } from './format'
import { PresencePill } from './PresencePill'
import { FollowButton, LiveValues } from '../telemetry/LiveValues'
import { useAircraftColours } from './colours'
import { Swatch } from './Swatch'

/** The one primary action, at the height of the quiet Follow beside it. */
const REGISTER_BUTTON =
  'rounded-pill bg-primary text-on-primary font-heading inline-flex h-9 items-center gap-2 px-4 text-sm font-semibold transition-[filter] duration-200 hover:brightness-95'

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
  const [form, setForm] = useForm()
  const heading = useId()
  const colourOf = useAircraftColours()
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

  // Registering lives in the URL, so the fleet panel's Register opens it here.
  if (form === 'register' && writes && fleet === undefined) {
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
          setForm(null)
        }}
      />
    )
  }

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={heading} className="flex items-center gap-2.5 text-lg font-semibold break-words">
            <Swatch colour={colourOf(aircraftKey(device.gatewaySn, device.aircraftSn))} />
            {device.aircraftSn}
          </h3>
          {fleet === undefined ? (
            <p className="text-muted text-sm">Not registered · via {device.stack.name}</p>
          ) : (
            <p className="text-muted text-sm">
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
            </p>
          )}
        </div>
        <PresencePill device={device} />
      </div>
      <div className="mt-3">
        <div className="-ml-3 flex flex-wrap items-center gap-2">
          <FollowButton aircraft={aircraftKey(device.gatewaySn, device.aircraftSn)} />
          {fleet === undefined && (
            <button
              type="button"
              className={`${REGISTER_BUTTON} ${UNAVAILABLE}`}
              aria-disabled={!writes}
              aria-describedby={writes ? undefined : reason}
              onClick={() => {
                if (writes) setForm('register')
              }}
            >
              <Plus size={15} aria-hidden />
              Register as a fleet
            </button>
          )}
        </div>
        {fleet === undefined && !writes && (
          <ReadOnlyReason id={reason} organization={organization.name} />
        )}
      </div>
      <LiveValues gatewaySn={device.gatewaySn} aircraftSn={device.aircraftSn} />
      <Details
        folded
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
    </article>
  )
}
