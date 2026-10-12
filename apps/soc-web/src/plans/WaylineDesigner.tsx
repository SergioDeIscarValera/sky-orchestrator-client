import { Check, Circle, Grid3x3, MapPin, MousePointer2, Spline, Trash2, Undo2 } from 'lucide-react'
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react'

import { useSelect } from '../app/router'
import { ALERT, FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../app/styles'
import type { WaylineChanges } from '../backend/backend'
import { useSettings } from '../config/settings'
import { designOf, sketchRefusals, type SketchRefusal } from './waylineSketch'
import type { Geodetic } from '../geometry/projection'
import { useCreateWayline, useChangeWayline } from './data'
import { useDesignerKeys } from './designerKeys'
import { formatLength } from './format'
import { bakeSketch } from './waylineBake'
import {
  figured,
  finished,
  gridSpaced,
  removedPrimitive,
  toolChosen,
  turned,
  undone,
  useWaylineDesigner,
  type Designing,
  type Tool,
} from './waylineDesigner'
import { draftOf, primitiveSummary } from './waylines'

const TOOLS: readonly {
  readonly tool: Tool
  readonly label: string
  readonly icon: typeof MapPin
}[] = [
  { tool: 'takeoff', label: 'Takeoff', icon: MapPin },
  { tool: 'route', label: 'Route', icon: Spline },
  { tool: 'points', label: 'Points', icon: MousePointer2 },
  { tool: 'circle', label: 'Circle', icon: Circle },
  { tool: 'grid', label: 'Grid', icon: Grid3x3 },
]

const REFUSALS: Readonly<Record<SketchRefusal, string>> = {
  name_missing: 'Name missing',
  takeoff_missing: 'Takeoff missing',
  height_missing: 'Height missing',
  height_not_positive: 'Height not above 0 m',
  primitive_height_not_positive: 'A drawn height not above 0 m',
  nothing_drawn: 'Nothing drawn',
}

/** A number typed, or null while the field is empty or holds no number. */
function readNumber(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

const shown = (value: number | null) => (value === null ? '' : String(value))

interface Props {
  readonly designing: Designing
  /** The scene's origin, the frame the wayline is baked on (ADR-0014). */
  readonly origin: Geodetic
}

/**
 * The wayline open in the designer (FR-WAY-01 to FR-WAY-07), beside the scene where it is
 * drawn: its name and default height, the tool the ground's clicks go to, what is drawn,
 * and the bake as it changes. A wayline is geometry: its speed, climb, finish and geofence
 * are set where an operation flies it (M4).
 */
export function WaylineDesigner({ designing, origin }: Props) {
  const change = useWaylineDesigner((state) => state.change)
  const stop = useWaylineDesigner((state) => state.stop)
  const select = useSelect()
  const settings = useSettings()
  const create = useCreateWayline()
  const update = useChangeWayline()
  const [texts, setTexts] = useState(() => ({
    height: shown(designing.sketch.defaultHeightM),
    lines: shown(designing.lineSpacingM),
    points: shown(designing.pointSpacingM),
  }))
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const heading = useId()
  const nameId = useId()
  useDesignerKeys()

  const { sketch, tool } = designing
  const baked = bakeSketch(sketch, { origin, maxArcSpacingM: settings.maxArcSpacingM })
  const refused = sketchRefusals(sketch)
  const saving = create.isPending || update.isPending
  const title = designing.waylineId === null ? 'New wayline' : `Edit ${sketch.name || 'wayline'}`

  const typed =
    (key: keyof typeof texts, apply: (value: number | null) => (current: Designing) => Designing) =>
    (text: string) => {
      setTexts((current) => ({ ...current, [key]: text }))
      change(apply(readNumber(text)))
    }

  const save = async (event: SyntheticEvent) => {
    event.preventDefault()
    setTried(true)
    setFailure(null)
    const design = designOf(sketch)
    if (refused.length > 0 || design === null || baked === null) return
    try {
      const draft = draftOf(sketch.name, design, baked)
      if (designing.waylineId === null) {
        const created = await create.mutateAsync(draft)
        select({ kind: 'wayline', waylineId: created.id })
      } else {
        const changes: WaylineChanges = draft
        await update.mutateAsync({ id: designing.waylineId, changes })
        select({ kind: 'wayline', waylineId: designing.waylineId })
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
            value={sketch.name}
            autoComplete="off"
            aria-invalid={tried && refused.includes('name_missing')}
            onChange={(event) => {
              const name = event.target.value
              change((current) => figured(current, { name }))
            }}
          />
        </Labelled>
        <Figure
          label="Height"
          unit="m"
          value={texts.height}
          invalid={tried && refused.some((r) => r.startsWith('height'))}
          onChange={typed(
            'height',
            (value) => (current) => figured(current, { defaultHeightM: value }),
          )}
        />
      </div>
      <div role="group" aria-label="Tools" className="mt-5 grid grid-cols-5 gap-1">
        {TOOLS.map(({ tool: each, label, icon: Icon }) => (
          <button
            key={each}
            type="button"
            aria-pressed={tool === each}
            className="text-muted hover:bg-primary-subtle hover:text-primary-emphasis aria-pressed:bg-primary-subtle aria-pressed:text-primary-emphasis flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-semibold transition-colors duration-200"
            onClick={() => {
              change((current) => toolChosen(current, current.tool === each ? null : each))
            }}
          >
            <Icon size={16} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {tool === 'circle' && (
        <div role="group" aria-label="Direction" className="mt-2 -ml-3 flex gap-1">
          {[true, false].map((clockwise) => (
            <button
              key={String(clockwise)}
              type="button"
              aria-pressed={designing.clockwise === clockwise}
              className={`${QUIET_BUTTON} aria-pressed:bg-primary-subtle aria-pressed:text-primary-emphasis`}
              onClick={() => {
                change((current) => turned(current, clockwise))
              }}
            >
              {clockwise ? 'Clockwise' : 'Anticlockwise'}
            </button>
          ))}
        </div>
      )}
      {tool === 'grid' && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Figure
            label="Between lines"
            unit="m"
            value={texts.lines}
            onChange={typed(
              'lines',
              (value) => (current) => gridSpaced(current, { lineSpacingM: value }),
            )}
          />
          <Figure
            label="Between points"
            unit="m"
            value={texts.points}
            onChange={typed(
              'points',
              (value) => (current) => gridSpaced(current, { pointSpacingM: value }),
            )}
          />
        </div>
      )}
      {sketch.primitives.length > 0 && (
        <ul aria-label="Drawn" className="mt-4 flex flex-col gap-1">
          {sketch.primitives.map((primitive, index) => {
            return (
              <li key={`${primitive.kind}-${String(index)}`} className="flex items-center gap-2">
                <span className="text-heading min-w-0 flex-1 truncate text-sm">
                  {primitiveSummary(primitive)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${primitiveSummary(primitive)}`}
                  className={`${QUIET_BUTTON} w-9 justify-center px-0`}
                  onClick={() => {
                    change((current) => removedPrimitive(current, index))
                  }}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Tile label="Waypoints">{baked === null ? '—' : String(baked.waypoints.length)}</Tile>
        <Tile label="Distance">{baked === null ? '—' : formatLength(baked.distanceM)}</Tile>
      </dl>
      {tried && refused.length > 0 && (
        <ul aria-label="Cannot be saved" className="mt-3 flex flex-wrap gap-1.5">
          {refused.map((refusal) => (
            <li
              key={refusal}
              className="rounded-pill bg-danger-subtle text-danger-emphasis px-2.5 py-1 text-xs font-semibold"
            >
              {REFUSALS[refusal]}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 -ml-3 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={QUIET_BUTTON}
          disabled={designing.past.length === 0 && designing.pending.length === 0}
          onClick={() => {
            change(undone)
          }}
        >
          <Undo2 size={15} aria-hidden />
          Undo
        </button>
        {(tool === 'route' || tool === 'points' || tool === 'grid') &&
          designing.pending.length > 0 && (
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                change(finished)
              }}
            >
              <Check size={15} aria-hidden />
              Finish
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
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-heading text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  )
}

function Figure({
  label,
  unit,
  value,
  invalid = false,
  onChange,
}: {
  readonly label: string
  readonly unit: string
  readonly value: string
  readonly invalid?: boolean
  readonly onChange: (text: string) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-heading text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          className={`${FIELD} min-w-0`}
          inputMode="decimal"
          value={value}
          aria-invalid={invalid}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <span className="text-muted text-xs">{unit}</span>
      </div>
    </div>
  )
}

function Tile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="bg-page rounded-xl px-3 py-2">
      <dt className="text-muted text-[11px] font-semibold tracking-wider uppercase">{label}</dt>
      <dd className="text-heading font-heading text-sm font-semibold tabular-nums">{children}</dd>
    </div>
  )
}
