import { Check, Hand, Trash2, Undo2 } from 'lucide-react'
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react'

import { useSelect } from '../app/router'
import { ALERT, FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../app/styles'
import type { GeofenceChanges, GeofenceDraft } from '../backend/backend'
import { useSettings } from '../config/settings'
import type { Geodetic } from '../geometry/projection'
import { useChangeGeofence, useCreateGeofence, useGeofences, useWaylines } from './data'
import { useEditorKeys } from './editorKeys'
import { formatArea, formatLength, refusalLabel } from './format'
import { generatedAround, LEAST_MARGIN_M, MOST_MARGIN_M } from './generate'
import { sameRing } from './geofences'
import { measure, refusals, type Refusal } from './geofenceDrawing'
import {
  byHand,
  ceiled,
  closed,
  deleted,
  regenerated,
  renamed,
  undone,
  useGeofenceEditor,
  type Editing,
  type Generating,
} from './geofenceEditor'
import { WaylinePicker } from './WaylinePicker'

/** What the drawing shows as it changes; the rest waits for Save. */
const LIVE: readonly Refusal[] = ['edges_meet', 'zero_length_edge', 'no_area']

/** The stack's envelope reaches the console with the operations (M4): until then, none. */
const ENVELOPE_CEILING_M = null

/** A number typed, or null while the field is empty or holds no number. */
function readMetres(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

interface Props {
  readonly editing: Editing
  /** The scene's origin, the frame the geofence is measured on (ADR-0014). */
  readonly origin: Geodetic
}

/**
 * The geofence open in the editor, beside the scene where it is drawn (FR-GEO-01): its
 * name and ceiling, its area and perimeter as it changes, the reasons it cannot be saved
 * yet (FR-GEO-04), and, generated, the waylines and the margin it follows (FR-GEO-03).
 */
export function GeofenceEditor({ editing, origin }: Props) {
  const change = useGeofenceEditor((state) => state.change)
  const stop = useGeofenceEditor((state) => state.stop)
  const select = useSelect()
  const settings = useSettings()
  const geofences = useGeofences()
  const waylines = useWaylines()
  const create = useCreateGeofence()
  const update = useChangeGeofence()
  const [ceilingText, setCeilingText] = useState(
    editing.drawing.maxHeightM === null ? '' : String(editing.drawing.maxHeightM),
  )
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const heading = useId()
  const nameId = useId()
  const ceilingId = useId()
  const marginId = useId()
  useEditorKeys()

  const { drawing, generating } = editing
  const measured = measure(drawing, origin)
  const refused = refusals(drawing, origin, ENVELOPE_CEILING_M)
  const shown = tried ? refused : refused.filter((refusal) => LIVE.includes(refusal))
  const saving = create.isPending || update.isPending
  const saved = geofences.data?.find(({ id }) => id === editing.geofenceId)
  const title =
    editing.geofenceId !== null
      ? `Edit ${saved?.name ?? 'geofence'}`
      : generating !== null
        ? 'Generate a geofence'
        : 'New geofence'

  const generate = (next: Generating) => {
    const chosen = (waylines.data ?? []).filter(({ id }) => next.waylineIds.includes(id))
    const points = chosen.flatMap((wayline) => [
      wayline.takeoff,
      ...wayline.waypoints.map(({ position }) => position),
    ])
    const vertices = generatedAround(points, origin, next.marginM, settings.geofenceMaxVertices)
    change((current) => regenerated(current, next, vertices))
  }

  const save = async (event: SyntheticEvent) => {
    event.preventDefault()
    setTried(true)
    setFailure(null)
    if (refused.length > 0 || drawing.maxHeightM === null) return
    const draft: GeofenceDraft = {
      name: drawing.name.trim(),
      polygon: drawing.vertices,
      maxHeightM: drawing.maxHeightM,
      origin: generating === null ? 'drawn' : 'generated',
      marginM: generating?.marginM ?? null,
    }
    try {
      if (editing.geofenceId === null) {
        const created = await create.mutateAsync(draft)
        select({ kind: 'geofence', geofenceId: created.id })
      } else {
        // A shape changed by hand is drawn from now on, whatever made it first.
        const reshaped = saved === undefined || !sameRing(saved.polygon, draft.polygon)
        const changes: GeofenceChanges = {
          ...(saved?.name === draft.name ? {} : { name: draft.name }),
          ...(saved?.maxHeightM === draft.maxHeightM ? {} : { maxHeightM: draft.maxHeightM }),
          ...(reshaped ? { polygon: draft.polygon, origin: 'drawn', marginM: null } : {}),
        }
        if (Object.keys(changes).length > 0) {
          await update.mutateAsync({ id: editing.geofenceId, changes })
        }
        select({ kind: 'geofence', geofenceId: editing.geofenceId })
      }
      stop()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <form
      aria-labelledby={heading}
      noValidate
      className="mt-3 flex min-h-0 flex-col overflow-y-auto"
      onSubmit={(event) => void save(event)}
    >
      <h3 id={heading} className="text-lg font-semibold break-words">
        {title}
      </h3>
      <div className="mt-4 flex flex-col gap-4">
        <Labelled id={nameId} label="Name">
          <input
            id={nameId}
            className={FIELD}
            value={drawing.name}
            autoComplete="off"
            aria-invalid={tried && refused.includes('name_missing')}
            onChange={(event) => {
              const name = event.target.value
              change((current) => renamed(current, name))
            }}
          />
        </Labelled>
        <Labelled id={ceilingId} label="Ceiling above takeoff">
          <div className="flex items-center gap-2">
            <input
              id={ceilingId}
              className={FIELD.replace('w-full', 'w-28')}
              inputMode="decimal"
              value={ceilingText}
              aria-invalid={
                tried &&
                (refused.includes('ceiling_missing') ||
                  refused.includes('ceiling_not_positive') ||
                  refused.includes('ceiling_above_envelope'))
              }
              onChange={(event) => {
                const text = event.target.value
                setCeilingText(text)
                change((current) => ceiled(current, readMetres(text)))
              }}
            />
            <span className="text-muted text-sm">m</span>
          </div>
        </Labelled>
        {generating !== null && (
          <>
            <WaylinePicker
              waylines={waylines.data ?? []}
              chosen={generating.waylineIds}
              onChange={(waylineIds) => {
                generate({ ...generating, waylineIds })
              }}
            />
            <Labelled id={marginId} label="Margin">
              <div className="flex items-center gap-3">
                <input
                  id={marginId}
                  type="range"
                  className="accent-primary flex-1"
                  min={LEAST_MARGIN_M}
                  max={MOST_MARGIN_M}
                  step={1}
                  value={generating.marginM}
                  onChange={(event) => {
                    generate({ ...generating, marginM: Number(event.target.value) })
                  }}
                />
                <output htmlFor={marginId} className="text-heading w-14 text-right text-sm">
                  {`${String(generating.marginM)} m`}
                </output>
              </div>
            </Labelled>
          </>
        )}
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-2">
        <Figure label="Area">{measured.areaM2 === null ? '—' : formatArea(measured.areaM2)}</Figure>
        <Figure label="Perimeter">{formatLength(measured.perimeterM)}</Figure>
        <Figure label="Vertices">{String(drawing.vertices.length)}</Figure>
      </dl>
      {shown.length > 0 && (
        <ul aria-label="Cannot be saved" className="mt-3 flex flex-wrap gap-1.5">
          {shown.map((refusal) => (
            <li
              key={refusal}
              className="rounded-pill bg-danger-subtle text-danger-emphasis px-2.5 py-1 text-xs font-semibold"
            >
              {refusalLabel(refusal, ENVELOPE_CEILING_M)}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 -ml-3 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={QUIET_BUTTON}
          disabled={editing.past.length === 0}
          onClick={() => {
            change(undone)
          }}
        >
          <Undo2 size={15} aria-hidden />
          Undo
        </button>
        {editing.phase === 'placing' && (
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={drawing.vertices.length < 3}
            onClick={() => {
              change(closed)
            }}
          >
            <Check size={15} aria-hidden />
            Close
          </button>
        )}
        {editing.picked !== null && (
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              change(deleted)
            }}
          >
            <Trash2 size={15} aria-hidden />
            {`Remove vertex ${String(editing.picked + 1)}`}
          </button>
        )}
        {generating !== null && drawing.vertices.length > 0 && (
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              change(byHand)
            }}
          >
            <Hand size={15} aria-hidden />
            Shape by hand
          </button>
        )}
      </div>
      {failure !== null && (
        <p role="alert" className={`${ALERT} mt-4`}>
          {failure}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" className={QUIET_BUTTON} disabled={saving} onClick={stop}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function Labelled({
  id,
  label,
  children,
}: {
  readonly id: string
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-heading text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  )
}

function Figure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="bg-page rounded-xl px-3 py-2">
      <dt className="text-muted text-[11px] font-semibold tracking-wider uppercase">{label}</dt>
      <dd className="text-heading font-heading text-sm font-semibold tabular-nums">{children}</dd>
    </div>
  )
}
