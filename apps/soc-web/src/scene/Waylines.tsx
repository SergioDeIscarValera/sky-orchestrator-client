import { Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect } from 'react'

import { useSelect, useSelection } from '../app/router'
import type { Geodetic } from '../geometry/projection'
import { useWaylines } from '../plans/data'
import { useWaylineDesigner } from '../plans/waylineDesigner'
import { Dots } from './Dots'
import { usePalette } from './palette'
import type { Site } from './site'
import { flownPath } from './waylinePath'

interface Props {
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The selected saved wayline as it flies (FR-WAY-09), in the accent colour with its
 * waypoints; the others stay out of the way, of a new one's design above all. The wayline
 * open in the designer is the designer's to draw.
 */
export function Waylines({ site, origin }: Props) {
  const waylines = useWaylines()
  const selection = useSelection()
  const select = useSelect()
  const designedId = useWaylineDesigner((state) => state.designing?.waylineId)
  const palette = usePalette()
  const invalidate = useThree((state) => state.invalidate)
  const selectedId = selection?.kind === 'wayline' ? selection.waylineId : null
  const shown = (waylines.data ?? []).filter(({ id }) => id !== designedId && id === selectedId)

  useEffect(() => {
    invalidate()
  }, [shown.length, selectedId, invalidate])

  return (
    <group>
      {shown.map((wayline) => {
        const chosen = wayline.id === selectedId
        const path = flownPath(
          {
            referencePoint: wayline.takeoff,
            takeoffSecurityHeightM: null,
            waypoints: wayline.waypoints.map(({ position, heightM }) => ({ ...position, heightM })),
          },
          origin,
          site,
        )
        return (
          <group key={wayline.id}>
            <Line
              name={`wayline ${wayline.name}`}
              points={path.points}
              color={chosen ? palette.accent : palette.gridMajor}
              lineWidth={chosen ? 2.5 : 1.5}
              depthTest={false}
              renderOrder={chosen ? 9 : 8}
              onClick={(event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation()
                select({ kind: 'wayline', waylineId: wayline.id })
              }}
            />
            {chosen && <Dots points={path.waypoints} colour={palette.accent} size={7} />}
          </group>
        )
      })}
    </group>
  )
}
