import { MapTools } from '../scene/MapTools'
import { Inspector } from './Inspector'
import { NavigationRail } from './NavigationRail'
import { PanelHost } from './PanelHost'
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
