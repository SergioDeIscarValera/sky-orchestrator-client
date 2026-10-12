import { Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect } from 'react'

import { useSelect, useSelection, useView } from '../app/router'
import type { Geodetic } from '../geometry/projection'
import { useGeofences } from '../plans/data'
import { useGeofenceEditor } from '../plans/geofenceEditor'
import { CeilingVolume } from './CeilingVolume'
import { draped } from './drape'
import { flatOf } from './groundTool'
import { usePalette } from './palette'
import type { Site } from './site'

/** As the editor's, so a saved geofence opened for editing does not move. */
const LIFT_M = 1

interface Props {
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The organization's saved geofences on the terrain (FR-GEO-02): every one while the
 * geofence panel is open, the selected one always, in the accent colour with its volume up
 * to its ceiling; a click on one selects it. The geofence open in the editor is the editor's to draw.
 */
export function Geofences({ site, origin }: Props) {
  const geofences = useGeofences()
  const selection = useSelection()
  const select = useSelect()
  const { panel } = useView()
  const editedId = useGeofenceEditor((state) => state.editing?.geofenceId)
  const palette = usePalette()
  const invalidate = useThree((state) => state.invalidate)
  const selectedId = selection?.kind === 'geofence' ? selection.geofenceId : null
  const shown = (geofences.data ?? []).filter(
    ({ id }) => id !== editedId && (panel === 'geofences' || id === selectedId),
  )

  useEffect(() => {
    invalidate()
  }, [shown.length, selectedId, invalidate])

  const step = site.spacingM === null ? Infinity : site.spacingM / 2
  return (
    <group>
      {shown.map((geofence) => {
        const chosen = geofence.id === selectedId
        const ring = geofence.polygon.map((vertex) => flatOf(origin, vertex))
        return (
          <group key={geofence.id}>
            {chosen && (
              <CeilingVolume
                ring={ring}
                site={site}
                ceilingM={geofence.maxHeightM}
                colour={palette.accent}
              />
            )}
            <Line
              name={`geofence ${geofence.name}`}
              points={draped(ring, site.ground, step, LIFT_M, true)}
              color={chosen ? palette.accent : palette.gridMajor}
              lineWidth={chosen ? 3 : 1.5}
              depthTest={false}
              renderOrder={chosen ? 9 : 8}
              onClick={(event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation()
                select({ kind: 'geofence', geofenceId: geofence.id })
              }}
            />
          </group>
        )
      })}
    </group>
  )
}
