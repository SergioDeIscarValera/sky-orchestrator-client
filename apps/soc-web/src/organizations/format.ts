import type { Position, Role } from '../backend/backend'

const ROLE_NAMES: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
}

export function roleName(role: Role): string {
  return ROLE_NAMES[role]
}

export function formatPosition(position: Position | null): string {
  if (position === null) return 'No position set'
  const latitude = `${Math.abs(position.latitude).toFixed(4)}° ${position.latitude < 0 ? 'S' : 'N'}`
  const longitude = `${Math.abs(position.longitude).toFixed(4)}° ${position.longitude < 0 ? 'W' : 'E'}`
  return `${latitude}, ${longitude}`
}
