import { Hexagon, ListChecks, Plane, Route, type LucideIcon } from 'lucide-react'

export const PANELS = ['fleet', 'geofences', 'waylines', 'operations'] as const
export type Panel = (typeof PANELS)[number]

interface Destination {
  readonly panel: Panel
  readonly label: string
  readonly icon: LucideIcon
}

export const DESTINATIONS: readonly Destination[] = [
  { panel: 'fleet', label: 'Fleet', icon: Plane },
  { panel: 'geofences', label: 'Geofences', icon: Hexagon },
  { panel: 'waylines', label: 'Waylines', icon: Route },
  { panel: 'operations', label: 'Operations', icon: ListChecks },
]
