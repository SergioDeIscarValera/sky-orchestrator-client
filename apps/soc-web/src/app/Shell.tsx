import { MapTools } from '../scene/MapTools'
import { NavigationRail } from './NavigationRail'
import { SceneRegion } from './SceneRegion'
import { TopBar } from './TopBar'

export function Shell() {
  return (
    <div className="bg-page relative h-dvh w-dvw overflow-hidden">
      <SceneRegion />
      <div className="pointer-events-none absolute inset-0 grid grid-cols-[auto_1fr_360px] grid-rows-[auto_1fr] gap-4 p-4">
        <div className="col-span-3">
          <TopBar />
        </div>
        <div className="self-start">
          <NavigationRail />
        </div>
        <div className="flex items-end justify-end">
          <MapTools />
        </div>
        <aside
          aria-label="Inspector"
          className="rounded-card bg-surface shadow-card pointer-events-auto self-start p-5"
        >
          <h2 className="text-sm font-semibold tracking-wider uppercase">Inspector</h2>
          <p className="mt-2 text-sm">Nothing selected.</p>
        </aside>
      </div>
    </div>
  )
}
