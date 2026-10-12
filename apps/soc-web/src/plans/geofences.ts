import type { Geofence } from '../backend/backend'
import type { Geodetic } from '../geometry/projection'
import { formatLength } from './format'
import { started, type Editing } from './geofenceEditor'

/** The margin a generation starts from, within IR-GEO's 5 to 100 m. */
export const FIRST_MARGIN_M = 20

/** How a geofence was made, and its ceiling: what the list and the inspector say under its name. */
export function geofenceSummary(geofence: Geofence): string {
  const made =
    geofence.origin === 'generated' && geofence.marginM !== null
      ? `Generated · ${formatLength(geofence.marginM)} margin`
      : 'Drawn'
  return `${made} · ceiling ${formatLength(geofence.maxHeightM)}`
}

/** A saved geofence as the editor opens it, shaped. */
export function editingOf(geofence: Geofence): Editing {
  return started({
    id: geofence.id,
    drawing: { name: geofence.name, vertices: geofence.polygon, maxHeightM: geofence.maxHeightM },
  })
}

/** The same vertices in the same order: a shape left as it was saved. */
export function sameRing(a: readonly Geodetic[], b: readonly Geodetic[]): boolean {
  if (a.length !== b.length) return false
  return a.every((vertex, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      vertex.latitudeDeg === other.latitudeDeg &&
      vertex.longitudeDeg === other.longitudeDeg
    )
  })
}
