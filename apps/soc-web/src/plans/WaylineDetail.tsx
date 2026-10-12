import { Archive, Copy, Pencil } from 'lucide-react'
import { useId, useState } from 'react'

import { useChangeView, useSelect } from '../app/router'
import { ALERT, DANGER_BUTTON, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { Details, Gone, Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { formatMoment } from '../fleets/format'
import { useOrganization } from '../organizations/context'
import { useSiteFrame } from '../scene/siteFrame'
import { useCreateWayline, useRetireWayline, useWaylines } from './data'
import { formatLength } from './format'
import { useWaylineDesigner } from './waylineDesigner'
import { designingOf, formatDuration, waylineSummary } from './waylines'

/** A wayline as saved, its bake as flown (FR-WAY-09), and what an editor does to it. */
export function WaylineDetail({ waylineId }: { readonly waylineId: string }) {
  const { organization } = useOrganization()
  const waylines = useWaylines()
  const create = useCreateWayline()
  const retire = useRetireWayline()
  const select = useSelect()
  const changeView = useChangeView()
  const begin = useWaylineDesigner((state) => state.begin)
  const open = useWaylineDesigner((state) => state.designing !== null)
  const { origin } = useSiteFrame()
  const [mode, setMode] = useState<'reading' | 'retiring'>('reading')
  const [refusal, setRefusal] = useState<string | null>(null)
  const heading = useId()
  const reason = useId()

  if (waylines.isPending) return <Waiting>Loading the waylines…</Waiting>
  if (waylines.isError) {
    return (
      <p role="alert" className={ALERT}>
        {waylines.error.message}
      </p>
    )
  }
  const wayline = waylines.data.find(({ id }) => id === waylineId)
  if (wayline === undefined) {
    return (
      <Gone>
        {organization.name} has no live wayline with this link: it may have been retired, or belong
        to another organization.
      </Gone>
    )
  }

  const writes = changesFleets(organization.role)
  const editable = writes && origin !== null && !open
  const zone = organization.timeZone
  const heights = wayline.waypoints.map(({ heightM }) => heightM)

  const edit = () => {
    setRefusal(null)
    try {
      begin(designingOf(wayline))
      changeView((view) => ({ ...view, panel: 'waylines' }))
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  const duplicate = async () => {
    setRefusal(null)
    try {
      const copy = await create.mutateAsync({
        name: `${wayline.name} (copy)`,
        takeoff: wayline.takeoff,
        defaultHeightM: wayline.defaultHeightM,
        speedMs: wayline.speedMs,
        design: wayline.design,
        waypoints: wayline.waypoints,
        metrics: wayline.metrics,
        bakeVersion: wayline.bakeVersion,
      })
      select({ kind: 'wayline', waylineId: copy.id })
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmRetirement = async () => {
    setRefusal(null)
    try {
      await retire.mutateAsync(wayline.id)
      select(null)
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article aria-labelledby={heading}>
      <h3 id={heading} className="text-lg font-semibold break-words">
        {wayline.name}
      </h3>
      <p className="text-muted text-sm">{waylineSummary(wayline)}</p>
      {mode === 'retiring' ? (
        <div role="group" aria-label={`Retire ${wayline.name}`} className="mt-4">
          <p className="text-sm">Retire {wayline.name}? It leaves the list for good.</p>
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
            <button
              type="button"
              className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
              aria-disabled={!editable}
              aria-describedby={writes ? undefined : reason}
              onClick={() => {
                if (editable) edit()
              }}
            >
              <Pencil size={15} aria-hidden />
              Edit
            </button>
            <button
              type="button"
              className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
              aria-disabled={!writes || create.isPending}
              aria-describedby={writes ? undefined : reason}
              onClick={() => {
                if (writes && !create.isPending) void duplicate()
              }}
            >
              <Copy size={15} aria-hidden />
              Duplicate
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
          {!writes && (
            <p id={reason} className="text-muted mt-2 text-xs">
              Your role in {organization.name} only reads: editors and owners change waylines.
            </p>
          )}
          {refusal !== null && (
            <p role="alert" className={`${ALERT} mt-3`}>
              {refusal}
            </p>
          )}
        </div>
      )}
      <Details
        title="Flight"
        rows={[
          ['Waypoints', String(wayline.metrics.waypointCount)],
          ['Distance', formatLength(wayline.metrics.distanceM)],
          ['Duration', formatDuration(wayline.metrics.durationS)],
          ['Speed', `${String(wayline.speedMs)} m/s`],
          [
            'Heights above takeoff',
            heights.length === 0
              ? '—'
              : `${formatLength(Math.min(...heights))} to ${formatLength(Math.max(...heights))}`,
          ],
        ]}
      />
      <Details
        folded
        title="History"
        rows={[
          ['Created', formatMoment(wayline.createdAt, zone)],
          ['Changed', formatMoment(wayline.updatedAt, zone)],
          ['Baked by', `version ${wayline.bakeVersion}`],
        ]}
      />
    </article>
  )
}
