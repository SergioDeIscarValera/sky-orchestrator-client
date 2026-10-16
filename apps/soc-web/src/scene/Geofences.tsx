import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'

import { useSelect, useSelection, useView } from '../app/router'
import type { Geodetic } from '../geometry/projection'
import { useGeofences } from '../plans/data'
import { useGeofenceEditor } from '../plans/geofenceEditor'
import { GeofenceOutline } from './GeofenceOutline'
import type { Site } from './site'

interface Props {
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The organization's saved geofences on the terrain (FR-GEO-02): every one while the geofence panel is
 * open, the selected one always, in the accent colour with its volume up to its ceiling; a click on one
 * selects it. The geofence open in the editor is the editor's to draw. While an operation is selected the
 * scene shows its own geofence alone, which OperationDrawing draws (FR-SCN-04): none of these.
 */
export function Geofences({ site, origin }: Props) {
  const geofences = useGeofences()
  const selection = useSelection()
  const select = useSelect()
  const { panel } = useView()
  const editedId = useGeofenceEditor((state) => state.editing?.geofenceId)
  const invalidate = useThree((state) => state.invalidate)
  const selectedId = selection?.kind === 'geofence' ? selection.geofenceId : null
  const shown =
    selection?.kind === 'operation'
      ? []
      : (geofences.data ?? []).filter(
          ({ id }) => id !== editedId && (panel === 'geofences' || id === selectedId),
        )

  useEffect(() => {
    invalidate()
  }, [shown.length, selectedId, invalidate])

  return (
    <group>
      {shown.map((geofence) => (
        <GeofenceOutline
          key={geofence.id}
          geofence={geofence}
          origin={origin}
          site={site}
          chosen={geofence.id === selectedId}
          onClick={() => {
            select({ kind: 'geofence', geofenceId: geofence.id })
          }}
        />
      ))}
    </group>
  )
}
