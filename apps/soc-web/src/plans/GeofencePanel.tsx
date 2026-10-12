import { Plus, RotateCw, Sparkles } from 'lucide-react'

import { useSelect, useSelection } from '../app/router'
import { ALERT, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import { useSiteFrame } from '../scene/siteFrame'
import { useGeofences, useWaylines } from './data'
import { GeofenceEditor } from './GeofenceEditor'
import { startedGenerating, useGeofenceEditor } from './geofenceEditor'
import { FIRST_MARGIN_M, geofenceSummary } from './geofences'

const ROW =
  'hover:bg-primary-subtle aria-pressed:bg-primary-subtle flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200'

/**
 * The organization's geofences (FR-GEO-02), and the editor in their place while one is
 * open (FR-GEO-01, FR-GEO-03). Drawing needs the scene on the map: an organization with
 * no position in Virtual Origen lists its geofences and draws none.
 */
export function GeofencePanel() {
  const editing = useGeofenceEditor((state) => state.editing)
  const { origin } = useSiteFrame()
  if (editing !== null && origin !== null) {
    const key = editing.geofenceId ?? (editing.generating === null ? 'new' : 'generated')
    return <GeofenceEditor key={key} editing={editing} origin={origin} />
  }
  return <GeofenceList placeable={origin !== null} />
}

function GeofenceList({ placeable }: { readonly placeable: boolean }) {
  const geofences = useGeofences()
  const waylines = useWaylines()
  const selection = useSelection()
  const select = useSelect()
  const start = useGeofenceEditor((state) => state.start)
  const begin = useGeofenceEditor((state) => state.begin)
  const { organization } = useOrganization()

  if (geofences.isPending) return <Waiting>Loading the geofences…</Waiting>
  if (geofences.isError) {
    return (
      <div className="mt-3">
        <p role="alert" className={ALERT}>
          {geofences.error.message}
        </p>
        <button
          type="button"
          className={`${QUIET_BUTTON} mt-3 -ml-3`}
          onClick={() => void geofences.refetch()}
        >
          <RotateCw size={16} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const writes = changesFleets(organization.role) && placeable
  const generable = writes && (waylines.data?.length ?? 0) > 0
  const selectedId = selection?.kind === 'geofence' ? selection.geofenceId : null

  return (
    <div className="-mx-2 mt-3 flex min-h-0 flex-col gap-3 overflow-y-auto px-2">
      <div className="-ml-1 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
          aria-disabled={!writes}
          onClick={() => {
            if (writes) start(null)
          }}
        >
          <Plus size={15} aria-hidden />
          New
        </button>
        <button
          type="button"
          className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
          aria-disabled={!generable}
          onClick={() => {
            if (generable) begin(startedGenerating(FIRST_MARGIN_M))
          }}
        >
          <Sparkles size={15} aria-hidden />
          Generate
        </button>
      </div>
      {geofences.data.length === 0 ? (
        <Waiting>No geofences yet.</Waiting>
      ) : (
        <ul aria-label="Geofences" className="flex flex-col gap-1">
          {geofences.data.map((geofence) => (
            <li key={geofence.id} className="flex">
              <button
                type="button"
                aria-pressed={geofence.id === selectedId}
                className={ROW}
                onClick={() => {
                  select(
                    geofence.id === selectedId
                      ? null
                      : { kind: 'geofence', geofenceId: geofence.id },
                  )
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-heading font-heading truncate text-sm font-semibold">
                    {geofence.name}
                  </span>
                  <span className="text-muted truncate text-xs">{geofenceSummary(geofence)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
