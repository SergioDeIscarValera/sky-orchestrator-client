import { Hexagon, ListChecks, Plane, Route, Settings, type LucideIcon } from 'lucide-react'

export const PANELS = ['fleet', 'geofences', 'waylines', 'operations', 'settings'] as const
export type Panel = (typeof PANELS)[number]

interface Destination {
  readonly panel: Panel
  readonly label: string
  readonly icon: LucideIcon
  /** Where the panel's content arrives, until it does. */
  readonly arrives?: string
}

export const DESTINATIONS: readonly Destination[] = [
  { panel: 'fleet', label: 'Fleet', icon: Plane },
  { panel: 'geofences', label: 'Geofences', icon: Hexagon },
  { panel: 'waylines', label: 'Waylines', icon: Route },
  { panel: 'operations', label: 'Operations', icon: ListChecks },
  { panel: 'settings', label: 'Settings', icon: Settings, arrives: 'M4' },
]
