import { X } from 'lucide-react'
import { useEffect, useId } from 'react'

import { FleetPanel } from '../fleets/FleetPanel'
import { DESTINATIONS } from './destinations'
import { useChangeView, useView } from './router'
import { CARD, QUIET_BUTTON } from './styles'

/** The open panel, floating beside the rail over the scene; Escape closes it. */
export function PanelHost() {
  const { panel } = useView()
  const change = useChangeView()
  const heading = useId()
  const destination = DESTINATIONS.find((candidate) => candidate.panel === panel)

  useEffect(() => {
    if (destination === undefined) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') change((view) => ({ ...view, panel: undefined }))
    }
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('keydown', close)
    }
  }, [destination, change])

  if (destination === undefined) return null
  return (
    <section
      aria-labelledby={heading}
      className={`${CARD} pointer-events-auto flex max-h-full w-96 flex-col p-5`}
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
            change((view) => ({ ...view, panel: undefined }))
          }}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {destination.panel === 'fleet' ? (
        <FleetPanel />
      ) : (
        <p className="text-muted mt-3 text-sm">
          {`${destination.label} arrive in ${destination.arrives ?? 'a later milestone'}.`}
        </p>
      )}
    </section>
  )
}
