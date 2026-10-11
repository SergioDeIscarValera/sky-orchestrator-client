import { Pencil, RotateCw } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { aircraftKey, type Device, type Fleet } from '../backend/backend'
import { useOpenForm, useSelect, useSelection, type Selection } from '../app/router'
import { ALERT, QUIET_BUTTON } from '../app/styles'
import { useOrganization } from '../organizations/context'
import { useAircraftColours } from './colours'
import { useAircraftModels, useDevices, useFleets } from './data'
import { Waiting } from './Details'
import { changesFleets } from './form'
import { PresencePill } from './PresencePill'
import { Swatch } from './Swatch'

const ROW =
  'hover:bg-primary-subtle aria-pressed:bg-primary-subtle flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200'
const ROW_ACTION =
  'text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-9 shrink-0 place-items-center rounded-xl transition-colors duration-200'
const REGISTER_ACTION =
  'rounded-pill bg-primary-subtle text-primary-emphasis hover:bg-primary hover:text-on-primary h-8 shrink-0 px-3 text-xs font-semibold transition-colors duration-200'

function sameAircraft(fleet: Fleet, device: Device): boolean {
  return fleet.gatewaySn === device.gatewaySn && fleet.aircraftSn === device.aircraftSn
}

function isSelected(selection: Selection | null, candidate: Selection): boolean {
  if (selection === null || selection.kind !== candidate.kind) return false
  if (selection.kind === 'fleet' && candidate.kind === 'fleet') {
    return selection.fleetId === candidate.fleetId
  }
  return (
    selection.kind === 'device' &&
    candidate.kind === 'device' &&
    selection.gatewaySn === candidate.gatewaySn &&
    selection.aircraftSn === candidate.aircraftSn
  )
}

/**
 * The organization's aircraft in one list (FR-FLE-02): its fleets first, then the
 * aircraft its stacks announced that are in none, each with what an editor does to it,
 * Edit or Register, at hand.
 */
export function FleetPanel() {
  const fleets = useFleets()
  const devices = useDevices()
  const colourOf = useAircraftColours()
  const models = useAircraftModels()
  const selection = useSelection()
  const select = useSelect()
  const openForm = useOpenForm()
  const { organization } = useOrganization()

  if (fleets.isPending || devices.isPending) return <Waiting>Loading the fleet…</Waiting>
  if (fleets.isError || devices.isError) {
    return (
      <div className="mt-3">
        <p role="alert" className={ALERT}>
          {(fleets.error ?? devices.error)?.message}
        </p>
        <button
          type="button"
          className={`${QUIET_BUTTON} mt-3 -ml-3`}
          onClick={() => {
            void fleets.refetch()
            void devices.refetch()
          }}
        >
          <RotateCw size={16} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const modelName = (model: string) =>
    models.data?.find((candidate) => candidate.model === model)?.displayName ?? model
  const unregistered = devices.data.filter(
    (device) => !fleets.data.some((fleet) => sameAircraft(fleet, device)),
  )
  const writes = changesFleets(organization.role)
  const toggle = (candidate: Selection) => {
    select(isSelected(selection, candidate) ? null : candidate)
  }
  const total = fleets.data.length + unregistered.length

  return (
    <div className="-mx-2 mt-3 flex min-h-0 flex-col gap-3 overflow-y-auto px-2">
      <p className="text-muted px-1 text-xs">
        Your registered aircraft first, then those a stack has announced that are not registered
        yet.
      </p>
      <Group title="Aircraft" count={total}>
        {total === 0 && (
          <Waiting>No aircraft yet: one appears here when a stack announces it.</Waiting>
        )}
        {fleets.data.map((fleet) => {
          const candidate: Selection = { kind: 'fleet', fleetId: fleet.id }
          const device = devices.data.find((seen) => sameAircraft(fleet, seen))
          return (
            <li key={fleet.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-pressed={isSelected(selection, candidate)}
                className={ROW}
                onClick={() => {
                  toggle(candidate)
                }}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Swatch colour={colourOf(aircraftKey(fleet.gatewaySn, fleet.aircraftSn))} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-heading font-heading truncate text-sm font-semibold">
                      {fleet.name}
                    </span>
                    <span className="text-muted truncate text-xs">{modelName(fleet.model)}</span>
                  </span>
                </span>
                {device !== undefined && <PresencePill device={device} />}
              </button>
              {writes && (
                <button
                  type="button"
                  aria-label={`Edit ${fleet.name}`}
                  title={`Edit ${fleet.name}`}
                  className={ROW_ACTION}
                  onClick={() => {
                    openForm(candidate, 'edit')
                  }}
                >
                  <Pencil size={15} aria-hidden />
                </button>
              )}
            </li>
          )
        })}
        {unregistered.map((device) => {
          const candidate: Selection = {
            kind: 'device',
            gatewaySn: device.gatewaySn,
            aircraftSn: device.aircraftSn,
          }
          return (
            <li
              key={`${device.gatewaySn}/${device.aircraftSn}`}
              className="flex items-center gap-1"
            >
              <button
                type="button"
                aria-pressed={isSelected(selection, candidate)}
                className={ROW}
                onClick={() => {
                  toggle(candidate)
                }}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Swatch colour={colourOf(aircraftKey(device.gatewaySn, device.aircraftSn))} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-heading truncate text-sm font-semibold">
                      {device.aircraftSn}
                    </span>
                    <span className="text-muted truncate text-xs">
                      Not registered · via {device.stack.name}
                    </span>
                  </span>
                </span>
                <PresencePill device={device} />
              </button>
              {writes && (
                <button
                  type="button"
                  aria-label={`Register ${device.aircraftSn}`}
                  className={REGISTER_ACTION}
                  onClick={() => {
                    openForm(candidate, 'register')
                  }}
                >
                  Register
                </button>
              )}
            </li>
          )
        })}
      </Group>
    </div>
  )
}

function Group({
  title,
  count,
  children,
}: {
  readonly title: string
  readonly count: number
  readonly children: ReactNode
}) {
  const heading = useId()
  return (
    <section aria-labelledby={heading}>
      <h3
        id={heading}
        className="text-muted flex items-center gap-2 text-xs font-semibold tracking-wider uppercase"
      >
        {title}
        <span className="rounded-pill bg-page text-muted px-2 tabular-nums">{count}</span>
      </h3>
      <ul className="mt-2 flex flex-col gap-1">{children}</ul>
    </section>
  )
}
