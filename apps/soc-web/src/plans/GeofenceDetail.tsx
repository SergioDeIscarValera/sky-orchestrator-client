import { Archive, Copy, Pencil } from 'lucide-react'
import { useId, useState } from 'react'

import { useChangeView, useSelect } from '../app/router'
import { ALERT, DANGER_BUTTON, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { Details, Gone, Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { formatMoment } from '../fleets/format'
import { useOrganization } from '../organizations/context'
import { useSiteFrame } from '../scene/siteFrame'
import { useCreateGeofence, useGeofences, useRetireGeofence } from './data'
import { formatArea, formatLength } from './format'
import { measure } from './geofenceDrawing'
import { useGeofenceEditor } from './geofenceEditor'
import { editingOf, geofenceSummary } from './geofences'

/** A geofence: its figures, and what an editor does to it (FR-GEO-02). */
export function GeofenceDetail({ geofenceId }: { readonly geofenceId: string }) {
  const { organization } = useOrganization()
  const geofences = useGeofences()
  const create = useCreateGeofence()
  const retire = useRetireGeofence()
  const select = useSelect()
  const changeView = useChangeView()
  const begin = useGeofenceEditor((state) => state.begin)
  const open = useGeofenceEditor((state) => state.editing !== null)
  const { origin } = useSiteFrame()
  const [mode, setMode] = useState<'reading' | 'retiring'>('reading')
  const [refusal, setRefusal] = useState<string | null>(null)
  const heading = useId()
  const reason = useId()

  if (geofences.isPending) return <Waiting>Loading the geofences…</Waiting>
  if (geofences.isError) {
    return (
      <p role="alert" className={ALERT}>
        {geofences.error.message}
      </p>
    )
  }
  const geofence = geofences.data.find(({ id }) => id === geofenceId)
  if (geofence === undefined) {
    return (
      <Gone>
        {organization.name} has no live geofence with this link: it may have been retired, or belong
        to another organization.
      </Gone>
    )
  }

  const writes = changesFleets(organization.role)
  // One geofence is edited at a time, and only on the map.
  const editable = writes && origin !== null && !open
  const drawing = {
    name: geofence.name,
    vertices: geofence.polygon,
    maxHeightM: geofence.maxHeightM,
  }
  const measured = origin === null ? null : measure(drawing, origin)
  const area = measured?.areaM2 ?? null
  const zone = organization.timeZone

  const duplicate = async () => {
    setRefusal(null)
    try {
      const copy = await create.mutateAsync({
        name: `${geofence.name} (copy)`,
        polygon: geofence.polygon,
        maxHeightM: geofence.maxHeightM,
        origin: geofence.origin,
        marginM: geofence.marginM,
      })
      select({ kind: 'geofence', geofenceId: copy.id })
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmRetirement = async () => {
    setRefusal(null)
    try {
      await retire.mutateAsync(geofence.id)
      select(null)
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article aria-labelledby={heading}>
      <h3 id={heading} className="text-lg font-semibold break-words">
        {geofence.name}
      </h3>
      <p className="text-muted text-sm">{geofenceSummary(geofence)}</p>
      {mode === 'retiring' ? (
        <div role="group" aria-label={`Retire ${geofence.name}`} className="mt-4">
          <p className="text-sm">Retire {geofence.name}? It leaves the list for good.</p>
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
                if (!editable) return
                begin(editingOf(geofence))
                changeView((view) => ({ ...view, panel: 'geofences' }))
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
              Your role in {organization.name} only reads: editors and owners change geofences.
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
        title="Figures"
        rows={[
          ['Ceiling', `${formatLength(geofence.maxHeightM)} above takeoff`],
          ['Area', area === null ? '—' : formatArea(area)],
          ['Perimeter', measured === null ? '—' : formatLength(measured.perimeterM)],
          ['Vertices', String(geofence.polygon.length)],
        ]}
      />
      <Details
        folded
        title="History"
        rows={[
          ['Created', formatMoment(geofence.createdAt, zone)],
          ['Changed', formatMoment(geofence.updatedAt, zone)],
        ]}
      />
    </article>
  )
}
