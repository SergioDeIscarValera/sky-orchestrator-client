import { Plus, RotateCw } from 'lucide-react'

import { useSelect, useSelection } from '../app/router'
import { ALERT, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import { useSiteFrame } from '../scene/siteFrame'
import { useWaylines } from './data'
import { WaylineDesigner } from './WaylineDesigner'
import { startedDesign, useWaylineDesigner } from './waylineDesigner'
import { waylineSummary } from './waylines'

const ROW =
  'hover:bg-primary-subtle aria-pressed:bg-primary-subtle flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200'

/**
 * The organization's waylines (FR-WAY-09), and the designer in their place while one is
 * open. Designing needs the scene on the map, as drawing a geofence does.
 */
export function WaylinePanel() {
  const designing = useWaylineDesigner((state) => state.designing)
  const { origin } = useSiteFrame()
  if (designing !== null && origin !== null) {
    return (
      <WaylineDesigner key={designing.waylineId ?? 'new'} designing={designing} origin={origin} />
    )
  }
  return <WaylineList placeable={origin !== null} />
}

function WaylineList({ placeable }: { readonly placeable: boolean }) {
  const waylines = useWaylines()
  const selection = useSelection()
  const select = useSelect()
  const begin = useWaylineDesigner((state) => state.begin)
  const { organization } = useOrganization()

  if (waylines.isPending) return <Waiting>Loading the waylines…</Waiting>
  if (waylines.isError) {
    return (
      <div className="mt-3">
        <p role="alert" className={ALERT}>
          {waylines.error.message}
        </p>
        <button
          type="button"
          className={`${QUIET_BUTTON} mt-3 -ml-3`}
          onClick={() => void waylines.refetch()}
        >
          <RotateCw size={16} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const writes = changesFleets(organization.role) && placeable
  const selectedId = selection?.kind === 'wayline' ? selection.waylineId : null

  return (
    <div className="-mx-2 mt-3 flex min-h-0 flex-col gap-3 overflow-y-auto px-2">
      <div className="-ml-1 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
          aria-disabled={!writes}
          onClick={() => {
            if (writes) begin(startedDesign())
          }}
        >
          <Plus size={15} aria-hidden />
          New
        </button>
      </div>
      {waylines.data.length === 0 ? (
        <Waiting>No waylines yet.</Waiting>
      ) : (
        <ul aria-label="Waylines" className="flex flex-col gap-1">
          {waylines.data.map((wayline) => (
            <li key={wayline.id} className="flex">
              <button
                type="button"
                aria-pressed={wayline.id === selectedId}
                className={ROW}
                onClick={() => {
                  select(
                    wayline.id === selectedId ? null : { kind: 'wayline', waylineId: wayline.id },
                  )
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-heading font-heading truncate text-sm font-semibold">
                    {wayline.name}
                  </span>
                  <span className="text-muted truncate text-xs">{waylineSummary(wayline)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
