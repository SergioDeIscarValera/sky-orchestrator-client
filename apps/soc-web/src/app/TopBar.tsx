import { CircleUserRound, Search } from 'lucide-react'

import { LiveClock } from './LiveClock'
import { ThemeToggle } from './ThemeToggle'

export function TopBar() {
  return (
    <header className="rounded-card bg-surface shadow-card pointer-events-auto flex h-14 items-center gap-4 px-4">
      <div className="flex items-center gap-2">
        <span aria-hidden className="rounded-pill bg-primary ring-casing size-3 ring-2" />
        <h1 className="text-base font-semibold tracking-wide">SOC</h1>
      </div>
      <span className="rounded-pill bg-secondary-subtle text-secondary-emphasis px-3 py-1 text-sm">
        No organization yet
      </span>
      <div className="text-muted ml-4 flex flex-1 items-center gap-2 text-sm">
        <Search size={16} aria-hidden />
        <span>Search</span>
        <kbd className="border-border rounded-md border px-1.5 text-xs">/</kbd>
      </div>
      <LiveClock />
      <ThemeToggle />
      <CircleUserRound size={22} className="text-muted" aria-label="Account" role="img" />
    </header>
  )
}
