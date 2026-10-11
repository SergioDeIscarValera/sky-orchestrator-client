import { RotateCw } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import type { Device, Fleet } from '../backend/backend'
import { useSelect, useSelection, type Selection } from '../app/router'
import { ALERT, QUIET_BUTTON } from '../app/styles'
import { useAircraftModels, useDevices, useFleets } from './data'
import { Waiting } from './Details'
import { PresencePill } from './PresencePill'

const ROW =
  'hover:bg-primary-subtle aria-pressed:bg-primary-subtle flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200'

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

/** The organization's fleets, and the aircraft its stacks announced that are in none (FR-FLE-02). */
export function FleetPanel() {
  const fleets = useFleets()
  const devices = useDevices()
  const models = useAircraftModels()
  const selection = useSelection()
  const select = useSelect()

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
  const toggle = (candidate: Selection) => {
    select(isSelected(selection, candidate) ? null : candidate)
  }

  return (
    <div className="-mx-2 mt-3 flex min-h-0 flex-col gap-5 overflow-y-auto px-2">
      <Group title="Fleets" count={fleets.data.length}>
        {fleets.data.length === 0 ? (
          <Waiting>
            No fleet registered yet. An aircraft a stack announces appears under Seen on the wire,
            to be registered from there.
          </Waiting>
        ) : (
          fleets.data.map((fleet) => {
            const candidate: Selection = { kind: 'fleet', fleetId: fleet.id }
            const device = devices.data.find((seen) => sameAircraft(fleet, seen))
            return (
              <li key={fleet.id}>
                <button
                  type="button"
                  aria-pressed={isSelected(selection, candidate)}
                  className={ROW}
                  onClick={() => {
                    toggle(candidate)
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-heading font-heading truncate text-sm font-semibold">
                      {fleet.name}
                    </span>
                    <span className="text-muted truncate text-xs">{modelName(fleet.model)}</span>
                  </span>
                  {device !== undefined && <PresencePill device={device} />}
                </button>
              </li>
            )
          })
        )}
      </Group>
      <Group title="Seen on the wire" count={unregistered.length}>
        {unregistered.length === 0 ? (
          <Waiting>
            {devices.data.length === 0
              ? 'No aircraft seen yet: one appears here when a stack announces it.'
              : 'Every aircraft seen is in a fleet.'}
          </Waiting>
        ) : (
          unregistered.map((device) => {
            const candidate: Selection = {
              kind: 'device',
              gatewaySn: device.gatewaySn,
              aircraftSn: device.aircraftSn,
            }
            return (
              <li key={`${device.gatewaySn}/${device.aircraftSn}`}>
                <button
                  type="button"
                  aria-pressed={isSelected(selection, candidate)}
                  className={ROW}
                  onClick={() => {
                    toggle(candidate)
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-heading truncate text-sm font-semibold">
                      {device.aircraftSn}
                    </span>
                    <span className="text-muted truncate text-xs">via {device.stack.name}</span>
                  </span>
                  <PresencePill device={device} />
                </button>
              </li>
            )
          })
        )}
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
