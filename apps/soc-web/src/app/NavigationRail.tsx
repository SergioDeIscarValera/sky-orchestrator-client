import { DESTINATIONS } from './destinations'

export function NavigationRail() {
  return (
    <nav
      aria-label="Sections"
      className="rounded-card bg-surface shadow-card pointer-events-auto flex flex-col gap-1 p-2"
    >
      {DESTINATIONS.map(({ label, icon: Icon }) => (
        <button
          key={label}
          type="button"
          title={label}
          aria-label={label}
          className="text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-11 place-items-center rounded-xl transition-colors duration-200"
        >
          <Icon size={20} />
        </button>
      ))}
    </nav>
  )
}
