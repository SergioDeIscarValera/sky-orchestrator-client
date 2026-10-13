import { useId, useState, type ReactNode } from 'react'

import {
  FieldRefusedError,
  type AircraftModel,
  type Assignment,
  type Fleet,
  type Geofence,
  type Operation,
  type StackView,
  type Wayline,
} from '../backend/backend'
import { ALERT, FIELD, PRIMARY_BUTTON } from '../app/styles'
import { Details } from '../fleets/Details'
import type { Geodetic } from '../geometry/projection'
import { useAssign, useChangeAssignment, useChangeOperation } from './data'
import {
  definitionFieldOf,
  envelopeOf,
  flightFor,
  MAX_HEIGHT_M,
  planSave,
  readDefinition,
  storedText,
  type DefinitionDraft,
  type DefinitionErrors,
  type DefinitionText,
} from './definition'

/** The organization's lists the definition takes its choices from, read before it is shown. */
export interface Choices {
  readonly waylines: readonly Wayline[]
  readonly fleets: readonly Fleet[]
  readonly geofences: readonly Geofence[]
  readonly stacks: readonly StackView[]
  readonly models: readonly AircraftModel[]
  /** The site frame's origin, which the flight is measured from (ADR-0014). */
  readonly origin: Geodetic | null
}

interface Props {
  readonly operation: Operation
  /** The operation's one assignment, if it has one (the MVP has at most one, FR-OPS-01). */
  readonly assignment: Assignment | null
  readonly choices: Choices
  /** Whether this member may change the definition now: an editor or owner, in an open state. */
  readonly editable: boolean
}

/**
 * The operation's definition (FR-OPS-01): its name, geofence, takeoff security height, and its
 * one assignment's wayline, fleet and speed. One Save writes what changed, and the assignment's
 * flight with it. Read-only where it may not change, with the same values.
 */
export function OperationDefinition({ operation, assignment, choices, editable }: Props) {
  const changeOperation = useChangeOperation()
  const assign = useAssign()
  const changeAssignment = useChangeAssignment()
  const [edits, setEdits] = useState<Partial<DefinitionText>>({})
  const [errors, setErrors] = useState<DefinitionErrors>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const heading = useId()

  if (!editable) {
    return <ReadOnly operation={operation} assignment={assignment} choices={choices} />
  }

  const text: DefinitionText = { ...storedText(operation, assignment), ...edits }
  const fleet = choices.fleets.find(({ id }) => id === text.fleetId)
  const maxSpeedMs =
    choices.models.find(({ model }) => model === fleet?.model)?.maxHorizontalSpeedMs ?? null

  const set = (field: keyof DefinitionText, value: string) => {
    setEdits((current) => ({ ...current, [field]: value }))
  }

  const save = async () => {
    setRefusal(null)
    const read = readDefinition(text, { maxSpeedMs })
    if (!read.ok) {
      setErrors(read.errors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      const plan = planSave({ operation, assignment }, read.draft, flightOf(read.draft, choices))
      if (plan.operation !== null) {
        await changeOperation.mutateAsync({ id: operation.id, changes: plan.operation })
      }
      if (plan.assignment?.kind === 'assign') {
        await assign.mutateAsync({ operationId: operation.id, draft: plan.assignment.draft })
      }
      if (plan.assignment?.kind === 'change') {
        await changeAssignment.mutateAsync({
          id: plan.assignment.id,
          changes: plan.assignment.changes,
        })
      }
      setEdits({})
    } catch (error) {
      // A refusal the database names is shown beside its field; any other is shown under Save.
      const field = error instanceof FieldRefusedError ? definitionFieldOf(error.field) : null
      const message = error instanceof Error ? error.message : String(error)
      if (field === null) setRefusal(message)
      else setErrors({ [field]: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      aria-labelledby={heading}
      noValidate
      className="mt-5"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
        Definition
      </h4>
      <div className="mt-3 flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          {(props) => (
            <input
              {...props}
              className={FIELD}
              value={text.name}
              autoComplete="off"
              onChange={(event) => {
                set('name', event.target.value)
              }}
            />
          )}
        </Field>
        <Field label="Geofence" error={errors.geofenceId}>
          {(props) => (
            <select
              {...props}
              className={FIELD}
              value={text.geofenceId}
              onChange={(event) => {
                set('geofenceId', event.target.value)
              }}
            >
              <option value="">None</option>
              {choices.geofences.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {isRetired(choices.geofences, text.geofenceId) && (
                <option value={text.geofenceId}>Retired</option>
              )}
            </select>
          )}
        </Field>
        <Field label="Takeoff security height" error={errors.heightM}>
          {(props) => (
            <span className="flex items-center gap-2">
              <span className="w-32 shrink-0">
                <input
                  {...props}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  max={MAX_HEIGHT_M}
                  className={FIELD}
                  value={text.heightM}
                  onChange={(event) => {
                    set('heightM', event.target.value)
                  }}
                />
              </span>
              <span className="text-muted text-sm">m</span>
            </span>
          )}
        </Field>
        <Field label="Wayline" error={errors.waylineId}>
          {(props) => (
            <select
              {...props}
              className={FIELD}
              value={text.waylineId}
              onChange={(event) => {
                set('waylineId', event.target.value)
              }}
            >
              {assignment === null && <option value="">None</option>}
              {choices.waylines.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {isRetired(choices.waylines, text.waylineId) && (
                <option value={text.waylineId}>Retired</option>
              )}
            </select>
          )}
        </Field>
        <Field label="Fleet" error={errors.fleetId}>
          {(props) => (
            <select
              {...props}
              className={FIELD}
              value={text.fleetId}
              onChange={(event) => {
                set('fleetId', event.target.value)
              }}
            >
              {assignment === null && <option value="">None</option>}
              {choices.fleets.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {isRetired(choices.fleets, text.fleetId) && (
                <option value={text.fleetId}>Retired</option>
              )}
            </select>
          )}
        </Field>
        <Field label="Speed" error={errors.speedMs}>
          {(props) => (
            <span className="flex items-center gap-2">
              <span className="w-32 shrink-0">
                <input
                  {...props}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  max={maxSpeedMs ?? undefined}
                  className={FIELD}
                  value={text.speedMs}
                  onChange={(event) => {
                    set('speedMs', event.target.value)
                  }}
                />
              </span>
              <span className="text-muted text-sm">m/s</span>
            </span>
          )}
        </Field>
      </div>
      {refusal !== null && (
        <p role="alert" className={`${ALERT} mt-4`}>
          {refusal}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="submit" className={PRIMARY_BUTTON} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

/** The flight the draft's assignment would store, from the lists it names; null while incomplete. */
function flightOf(draft: DefinitionDraft, choices: Choices): Record<string, unknown> | null {
  const fleet = choices.fleets.find(({ id }) => id === draft.fleetId)
  const stack = choices.stacks.find(({ gatewaySn }) => gatewaySn === fleet?.gatewaySn)
  return flightFor({
    wayline: choices.waylines.find(({ id }) => id === draft.waylineId),
    fleet,
    heightM: draft.heightM,
    speedMs: draft.speedMs,
    origin: choices.origin,
    envelope: envelopeOf(stack),
  })
}

/** A choice the operation holds that the organization's live list does not: it was retired. */
function isRetired(list: readonly { readonly id: string }[], id: string): boolean {
  return id !== '' && !list.some((item) => item.id === id)
}

/** The name of a chosen row, None where nothing is chosen, Retired where the list no longer has it. */
function nameOf(
  list: readonly { readonly id: string; readonly name: string }[],
  id: string | null,
) {
  if (id === null) return 'None'
  return list.find((item) => item.id === id)?.name ?? 'Retired'
}

function ReadOnly({
  operation,
  assignment,
  choices,
}: {
  readonly operation: Operation
  readonly assignment: Assignment | null
  readonly choices: Choices
}) {
  const height = operation.takeoffSecurityHeightM
  const speed = assignment?.speedMs ?? null
  return (
    <Details
      title="Definition"
      rows={[
        ['Name', operation.name],
        ['Geofence', nameOf(choices.geofences, operation.geofenceId)],
        ['Takeoff security height', height === null ? 'Not set' : `${String(height)} m`],
        ['Wayline', nameOf(choices.waylines, assignment?.waylineId ?? null)],
        ['Fleet', nameOf(choices.fleets, assignment?.fleetId ?? null)],
        ['Speed', speed === null ? 'Not set' : `${String(speed)} m/s`],
      ]}
    />
  )
}

interface FieldProps {
  readonly id: string
  readonly 'aria-invalid': boolean
  readonly 'aria-describedby': string | undefined
}

/** A labelled control, with the refusal or the check's message beneath it, named by the control. */
function Field({
  label,
  error,
  children,
}: {
  readonly label: string
  readonly error: string | undefined
  readonly children: (props: FieldProps) => ReactNode
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-heading text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby': error === undefined ? undefined : `${id}-error`,
      })}
      {error !== undefined && (
        <p id={`${id}-error`} className="text-danger-emphasis text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
