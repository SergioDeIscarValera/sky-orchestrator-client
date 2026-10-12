import { useEffect } from 'react'

import { MapTools } from '../scene/MapTools'
import { Inspector } from './Inspector'
import { NavigationRail } from './NavigationRail'
import { PanelHost } from './PanelHost'
import { select, selectionOf, useChangeView, useSelection } from './router'
import { SceneRegion } from './SceneRegion'
import { TopBar } from './TopBar'

/**
 * Escape steps back once: it clears the selection, then it closes the panel (NFR-UX-04).
 * An Escape something else took, closing the search's results say, is not a step back.
 */
function useEscapeStepsBack() {
  const change = useChangeView()
  useEffect(() => {
    const back = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      change((view) =>
        selectionOf(view) !== null ? select(view, null) : { ...view, panel: undefined },
      )
    }
    window.addEventListener('keydown', back)
    return () => {
      window.removeEventListener('keydown', back)
    }
  }, [change])
}

export function Shell() {
  const selected = useSelection() !== null
  useEscapeStepsBack()
  return (
    <div className="bg-page relative h-dvh w-dvw overflow-hidden">
      <SceneRegion />
      {/* The second row never grows past the window: a panel taller than it scrolls inside
          itself, and the map tools stay in view. */}
      <div
        className={`pointer-events-none absolute inset-0 grid grid-rows-[auto_minmax(0,1fr)] gap-4 p-4 ${
          selected ? 'grid-cols-[auto_1fr_360px]' : 'grid-cols-[auto_1fr]'
        }`}
      >
        <div className="col-span-full">
          <TopBar />
        </div>
        <div className="self-start">
          <NavigationRail />
        </div>
        <div className="flex min-h-0 flex-col items-start justify-between">
          <PanelHost />
          {/* Bottom right whether or not a panel is open (the design system). */}
          <div className="mt-auto self-end">
            <MapTools />
          </div>
        </div>
        <Inspector />
      </div>
    </div>
  )
}
