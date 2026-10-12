import { DESTINATIONS } from './destinations'
import { useChangeView, useView, withPanel } from './router'
import { CARD } from './styles'

export function NavigationRail() {
  const { panel } = useView()
  const change = useChangeView()
  return (
    <nav aria-label="Sections" className={`${CARD} pointer-events-auto flex flex-col gap-1 p-2`}>
      {DESTINATIONS.map(({ panel: destination, label, icon: Icon }) => (
        <button
          key={destination}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={panel === destination}
          onClick={() => {
            change(() => withPanel(panel === destination ? undefined : destination))
          }}
          className="text-muted hover:bg-primary-subtle hover:text-primary-emphasis aria-pressed:bg-primary-subtle aria-pressed:text-primary-emphasis grid size-11 place-items-center rounded-xl transition-colors duration-200"
        >
          <Icon size={20} />
        </button>
      ))}
    </nav>
  )
}
