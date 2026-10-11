import { NavigationRail } from './NavigationRail'
import { TopBar } from './TopBar'

export function Shell() {
  return (
    <div className="bg-page relative h-dvh w-dvw overflow-hidden">
      <main
        aria-label="Scene"
        className="text-muted absolute inset-0 grid place-items-center text-sm"
      >
        The farm's scene arrives here.
      </main>
      <div className="pointer-events-none absolute inset-0 grid grid-cols-[auto_1fr_360px] grid-rows-[auto_1fr] gap-4 p-4">
        <div className="col-span-3">
          <TopBar />
        </div>
        <div className="self-start">
          <NavigationRail />
        </div>
        <div />
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
