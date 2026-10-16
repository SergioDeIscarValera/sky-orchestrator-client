import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { useMemo } from 'react'

import type { Geofence } from '../backend/backend'
import type { Geodetic } from '../geometry/projection'
import { CeilingVolume } from './CeilingVolume'
import { draped } from './drape'
import { flatOf } from './groundTool'
import { usePalette } from './palette'
import type { Site } from './site'

/** As the editor's, so a saved geofence opened for editing does not move. */
const LIFT_M = 1

interface Props {
  readonly geofence: Geofence
  readonly origin: Geodetic
  readonly site: Site
  /** A chosen geofence is drawn in the accent colour, wider, with its volume up to its ceiling. */
  readonly chosen: boolean
  readonly onClick?: () => void
}

/** A saved geofence on the terrain (FR-GEO-02): its outline, and, chosen, its volume up to its ceiling. */
export function GeofenceOutline({ geofence, origin, site, chosen, onClick }: Props) {
  const palette = usePalette()
  const step = site.spacingM === null ? Infinity : site.spacingM / 2
  const ring = useMemo(
    () => geofence.polygon.map((vertex) => flatOf(origin, vertex)),
    [geofence.polygon, origin],
  )
  const points = useMemo(() => draped(ring, site.ground, step, LIFT_M, true), [ring, site, step])
  return (
    <group>
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
        points={points}
        color={chosen ? palette.accent : palette.gridMajor}
        lineWidth={chosen ? 3 : 1.5}
        depthTest={false}
        renderOrder={chosen ? 9 : 8}
        onClick={
          onClick === undefined
            ? undefined
            : (event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation()
                onClick()
              }
        }
      />
    </group>
  )
}
