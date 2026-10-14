import { useEffect } from 'react'

import { SafetyBar } from '../operations/SafetyBar'
import { MapTools } from '../scene/MapTools'
import { Inspector } from './Inspector'
import { NavigationRail } from './NavigationRail'
import { PanelHost } from './PanelHost'
import { RegionBoundary } from './RegionBoundary'
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
      {/* Every region fails alone (FR-CMD-07): the others, and the safety controls, keep working. */}
      <RegionBoundary name="scene" className="absolute inset-0 grid place-items-center p-8">
        <SceneRegion />
      </RegionBoundary>
      {/* The second row never grows past the window: a panel taller than it scrolls inside
          itself, and the map tools stay in view. */}
      <div
        className={`pointer-events-none absolute inset-0 grid grid-rows-[auto_minmax(0,1fr)] gap-4 p-4 ${
          selected ? 'grid-cols-[auto_1fr_360px]' : 'grid-cols-[auto_1fr]'
        }`}
      >
        <div className="col-span-full">
          <RegionBoundary name="top bar">
            <TopBar />
          </RegionBoundary>
        </div>
        <div className="self-start">
          <RegionBoundary name="navigation">
            <NavigationRail />
          </RegionBoundary>
        </div>
        <div className="flex min-h-0 flex-col items-start justify-between">
          <PanelHost />
          {/* The safety controls bottom left and the map tools bottom right, whether or not a
              panel is open (the design system), so the controls are on every screen (FR-CMD-07). */}
          <div className="mt-auto flex w-full items-end justify-between gap-4">
            <RegionBoundary name="safety controls">
              <SafetyBar />
            </RegionBoundary>
            <div className="ml-auto">
              <RegionBoundary name="map tools">
                <MapTools />
              </RegionBoundary>
            </div>
          </div>
        </div>
        <Inspector />
      </div>
    </div>
  )
}
