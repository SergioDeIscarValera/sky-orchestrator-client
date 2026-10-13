import { X } from 'lucide-react'
import { lazy, Suspense, useId } from 'react'

import { Waiting } from '../fleets/Details'
import { FleetPanel } from '../fleets/FleetPanel'
import { DESTINATIONS } from './destinations'
import { useChangeView, useView, withPanel } from './router'
import { CARD, QUIET_BUTTON } from './styles'

// The plans' panels and their geometry load when first opened, outside the first load
// (NFR-PERF-05). So do the operations' panel and its queries.
const GeofencePanel = lazy(() =>
  import('../plans/GeofencePanel').then(({ GeofencePanel: panel }) => ({ default: panel })),
)
const WaylinePanel = lazy(() =>
  import('../plans/WaylinePanel').then(({ WaylinePanel: panel }) => ({ default: panel })),
)
const OperationPanel = lazy(() =>
  import('../operations/OperationPanel').then(({ OperationPanel: panel }) => ({ default: panel })),
)

/** The open panel, floating beside the rail over the scene; Escape closes it (the shell's). */
export function PanelHost() {
  const { panel } = useView()
  const change = useChangeView()
  const heading = useId()
  const destination = DESTINATIONS.find((candidate) => candidate.panel === panel)

  if (destination === undefined) return null
  return (
    <section
      aria-labelledby={heading}
      className={`${CARD} pointer-events-auto flex max-h-full min-h-0 w-96 flex-col p-5`}
    >
      <div className="flex items-center justify-between">
        <h2 id={heading} className="text-sm font-semibold tracking-wider uppercase">
          {destination.label}
        </h2>
        <button
          type="button"
          aria-label={`Close ${destination.label}`}
          className={QUIET_BUTTON}
          onClick={() => {
            change(() => withPanel(undefined))
          }}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {destination.panel === 'fleet' ? (
        <FleetPanel />
      ) : destination.panel === 'geofences' ? (
        <Suspense fallback={<Waiting>Loading the geofences…</Waiting>}>
          <GeofencePanel />
        </Suspense>
      ) : destination.panel === 'waylines' ? (
        <Suspense fallback={<Waiting>Loading the waylines…</Waiting>}>
          <WaylinePanel />
        </Suspense>
      ) : destination.panel === 'operations' ? (
        <Suspense fallback={<Waiting>Loading the operations…</Waiting>}>
          <OperationPanel />
        </Suspense>
      ) : (
        <p className="text-muted mt-3 text-sm">
          {`${destination.label} arrive in ${destination.arrives ?? 'a later milestone'}.`}
        </p>
      )}
    </section>
  )
}
