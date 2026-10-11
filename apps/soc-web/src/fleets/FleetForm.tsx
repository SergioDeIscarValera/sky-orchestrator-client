import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'

import { FieldRefusedError, type FleetDraft } from '../backend/backend'
import { ALERT, FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../app/styles'
import { useAircraftModels } from './data'
import {
  formFieldOf,
  readValues,
  type FleetFormValues,
  type FormErrors,
  type FormField,
} from './form'

export interface AircraftChoice {
  readonly key: string
  readonly label: string
}

interface Props {
  readonly title: string
  readonly initial: FleetFormValues
  /** The aircraft the fleet may fly as; one means it is not a choice. */
  readonly aircraft: readonly AircraftChoice[]
  readonly submitLabel: string
  readonly onSubmit: (draft: FleetDraft) => Promise<void>
  readonly onCancel: () => void
}

/** Registering or editing a fleet in the inspector, never in a dialog (FR-FLE-03, FR-FLE-05). */
export function FleetForm({ title, initial, aircraft, submitLabel, onSubmit, onCancel }: Props) {
  const models = useAircraftModels()
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<FormErrors>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const heading = useId()

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors])

  const set = (field: keyof FleetFormValues) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setRefusal(null)
    const read = readValues(values)
    if (!read.ok) {
      setErrors(read.errors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      await onSubmit(read.draft)
    } catch (error) {
      const field = error instanceof FieldRefusedError ? formFieldOf(error.field) : null
      const message = error instanceof Error ? error.message : String(error)
      if (field === null) setRefusal(message)
      else setErrors({ [field]: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form ref={form} aria-labelledby={heading} noValidate onSubmit={(event) => void submit(event)}>
      <h3 id={heading} className="text-lg font-semibold break-words">
        {title}
      </h3>
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Name" field="name" errors={errors}>
          {(props) => (
            <input
              {...props}
              className={FIELD}
              value={values.name}
              autoComplete="off"
              onChange={(event) => {
                set('name')(event.target.value)
              }}
            />
          )}
        </Field>
        <Field label="Model" field="model" errors={errors}>
          {(props) => (
            <select
              {...props}
              className={FIELD}
              value={values.model}
              onChange={(event) => {
                set('model')(event.target.value)
              }}
            >
              <option value="" disabled>
                {models.isPending ? 'Loading the catalogue…' : 'Choose a model'}
              </option>
              {models.data?.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.displayName}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Airframe serial"
          hint="As printed on the airframe."
          field="airframeSerial"
          errors={errors}
        >
          {(props) => (
            <input
              {...props}
              className={FIELD}
              value={values.airframeSerial}
              autoComplete="off"
              onChange={(event) => {
                set('airframeSerial')(event.target.value)
              }}
            />
          )}
        </Field>
        <Field label="Controller serial" hint="Optional." field="controllerSerial" errors={errors}>
          {(props) => (
            <input
              {...props}
              className={FIELD}
              value={values.controllerSerial}
              autoComplete="off"
              onChange={(event) => {
                set('controllerSerial')(event.target.value)
              }}
            />
          )}
        </Field>
        <FlightTime values={values} errors={errors} set={set} />
        <Field label="Aircraft on the wire" field="aircraft" errors={errors}>
          {(props) =>
            aircraft.length > 1 ? (
              <select
                {...props}
                className={FIELD}
                value={values.aircraft}
                onChange={(event) => {
                  set('aircraft')(event.target.value)
                }}
              >
                {aircraft.map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <output {...props} className="text-heading block text-sm">
                {aircraft[0]?.label}
              </output>
            )
          }
        </Field>
      </div>
      {refusal !== null && (
        <p role="alert" className={`${ALERT} mt-4`}>
          {refusal}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" className={QUIET_BUTTON} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

interface FieldProps {
  readonly id: string
  readonly 'aria-invalid': boolean
  readonly 'aria-describedby': string | undefined
}

function Field({
  label,
  hint,
  field,
  errors,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly field: FormField
  readonly errors: FormErrors
  readonly children: (props: FieldProps) => ReactNode
}) {
  const id = useId()
  const error = errors[field]
  const described = [
    hint === undefined ? null : `${id}-hint`,
    error === undefined ? null : `${id}-error`,
  ]
    .filter((part) => part !== null)
    .join(' ')
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-heading text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby': described === '' ? undefined : described,
      })}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-muted text-xs">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${id}-error`} className="text-danger-emphasis text-xs">
          {error}
        </p>
      )}
    </div>
  )
}

function FlightTime({
  values,
  errors,
  set,
}: {
  readonly values: FleetFormValues
  readonly errors: FormErrors
  readonly set: (field: keyof FleetFormValues) => (value: string) => void
}) {
  const id = useId()
  const error = errors.flightTime
  const box = (field: 'hours' | 'minutes', label: string) => (
    <label className="text-muted flex items-center gap-2 text-sm">
      <input
        className={`${FIELD} w-24`}
        inputMode="numeric"
        aria-label={`Flight time before SOC, ${label}`}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        value={values[field]}
        onChange={(event) => {
          set(field)(event.target.value)
        }}
      />
      {label}
    </label>
  )
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-heading text-sm font-medium">Flight time before SOC</legend>
      <div className="mt-1.5 flex items-center gap-4">
        {box('hours', 'hours')}
        {box('minutes', 'minutes')}
      </div>
      {error !== undefined && (
        <p id={`${id}-error`} className="text-danger-emphasis text-xs">
          {error}
        </p>
      )}
    </fieldset>
  )
}
