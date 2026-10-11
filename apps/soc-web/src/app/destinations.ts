import { Hexagon, ListChecks, Plane, Route, Settings, type LucideIcon } from 'lucide-react'

interface Destination {
  readonly label: string
  readonly icon: LucideIcon
}

export const DESTINATIONS: readonly Destination[] = [
  { label: 'Fleet', icon: Plane },
  { label: 'Geofences', icon: Hexagon },
  { label: 'Waylines', icon: Route },
  { label: 'Operations', icon: ListChecks },
  { label: 'Settings', icon: Settings },
]
