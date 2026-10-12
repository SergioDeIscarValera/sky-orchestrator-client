import { Archive, Pencil } from 'lucide-react'
import { useId, useState } from 'react'

import { useForm, useSelect } from '../app/router'
import { ALERT, DANGER_BUTTON, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { useOrganization } from '../organizations/context'
import { useAircraftModels, useChangeFleet, useDevices, useFleets, useRetireFleet } from './data'
import { Details, Gone, ReadOnlyReason, Waiting } from './Details'
import { FleetForm, type AircraftChoice } from './FleetForm'
import { aircraftKey } from '../backend/backend'
import { changesFleets, changesFrom, readValues, valuesOf } from './form'
import { formatDuration, formatMoment, stackLabel } from './format'
import { ModelSpecs } from './ModelSpecs'
import { PresencePill } from './PresencePill'
import { FollowButton, LiveValues } from '../telemetry/LiveValues'
import { useAircraftColours } from './colours'
import { Swatch } from './Swatch'

/** A fleet's identity, what its stack last said of it, its model, and its changes (FR-FLE-04, FR-FLE-05). */
export function FleetDetail({ fleetId }: { readonly fleetId: string }) {
  const { organization } = useOrganization()
  const fleets = useFleets()
  const devices = useDevices()
  const models = useAircraftModels()
  const change = useChangeFleet()
  const retire = useRetireFleet()
  const select = useSelect()
  const [mode, setMode] = useState<'reading' | 'retiring'>('reading')
  const [form, setForm] = useForm()
  const [refusal, setRefusal] = useState<string | null>(null)
  const heading = useId()
  const colourOf = useAircraftColours()
  const reason = useId()

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
  const writes = changesFleets(organization.role)
  const zone = organization.timeZone

  // Editing lives in the URL: the Edit button opens the form here.
  if (form === 'edit' && writes) {
    const before = readValues(valuesOf(fleet))
    return (
      <FleetForm
        title={`Edit ${fleet.name}`}
        initial={valuesOf(fleet)}
        aircraft={aircraftChoices(fleet, devices.data ?? [], fleets.data)}
        submitLabel="Save"
        onSubmit={async (draft) => {
          const changes = before.ok ? changesFrom(before.draft, draft) : draft
          if (Object.keys(changes).length > 0) {
            await change.mutateAsync({ id: fleet.id, changes })
          }
          setForm(null)
        }}
        onCancel={() => {
          setForm(null)
        }}
      />
    )
  }

  const confirmRetirement = async () => {
    setRefusal(null)
    try {
      await retire.mutateAsync(fleet.id)
      select({ kind: 'device', gatewaySn: fleet.gatewaySn, aircraftSn: fleet.aircraftSn })
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={heading} className="flex items-center gap-2.5 text-lg font-semibold break-words">
            <Swatch colour={colourOf(aircraftKey(fleet.gatewaySn, fleet.aircraftSn))} />
            {fleet.name}
          </h3>
          <p className="text-muted text-sm">
            {model?.displayName ?? fleet.model} · {fleet.aircraftSn}
          </p>
        </div>
        {device !== undefined && <PresencePill device={device} />}
      </div>
      {mode === 'retiring' ? (
        <div role="group" aria-label={`Retire ${fleet.name}`} className="mt-4">
          <p className="text-sm">
            Retire {fleet.name}? It leaves the fleet for good: its history stays, and its aircraft
            can be registered again.
          </p>
          {refusal !== null && (
            <p role="alert" className={`${ALERT} mt-3`}>
              {refusal}
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className={QUIET_BUTTON}
              disabled={retire.isPending}
              onClick={() => {
                setRefusal(null)
                setMode('reading')
              }}
            >
              Keep it
            </button>
            <button
              type="button"
              className={DANGER_BUTTON}
              disabled={retire.isPending}
              onClick={() => void confirmRetirement()}
            >
              {retire.isPending ? 'Retiring…' : 'Retire for good'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="-ml-3 flex flex-wrap items-center gap-1">
            <FollowButton aircraft={aircraftKey(fleet.gatewaySn, fleet.aircraftSn)} />
            <button
              type="button"
              className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
              aria-disabled={!writes}
              aria-describedby={writes ? undefined : reason}
              onClick={() => {
                if (writes) setForm('edit')
              }}
            >
              <Pencil size={15} aria-hidden />
              Edit
            </button>
            <button
              type="button"
              className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
              aria-disabled={!writes}
              aria-describedby={writes ? undefined : reason}
              onClick={() => {
                if (writes) setMode('retiring')
              }}
            >
              <Archive size={15} aria-hidden />
              Retire
            </button>
          </div>
          {!writes && <ReadOnlyReason id={reason} organization={organization.name} />}
        </div>
      )}
      <LiveValues gatewaySn={fleet.gatewaySn} aircraftSn={fleet.aircraftSn} />
      <Details
        folded
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
          folded
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

/** The fleet's own aircraft, then every aircraft seen that no live fleet flies as. */
function aircraftChoices(
  fleet: { readonly id: string; readonly gatewaySn: string; readonly aircraftSn: string },
  devices: readonly { gatewaySn: string; aircraftSn: string; stack: { name: string } }[],
  fleets: readonly { id: string; gatewaySn: string; aircraftSn: string }[],
): AircraftChoice[] {
  const own = devices.find(
    (seen) => seen.gatewaySn === fleet.gatewaySn && seen.aircraftSn === fleet.aircraftSn,
  )
  const free = devices.filter(
    (seen) =>
      seen !== own &&
      !fleets.some(
        (other) => other.gatewaySn === seen.gatewaySn && other.aircraftSn === seen.aircraftSn,
      ),
  )
  return [
    {
      key: aircraftKey(fleet.gatewaySn, fleet.aircraftSn),
      label: `${fleet.aircraftSn} via ${own?.stack.name ?? fleet.gatewaySn} (now)`,
    },
    ...free.map((seen) => ({
      key: aircraftKey(seen.gatewaySn, seen.aircraftSn),
      label: `${seen.aircraftSn} via ${seen.stack.name}`,
    })),
  ]
}
