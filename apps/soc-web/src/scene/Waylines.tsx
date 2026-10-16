import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'

import { useSelect, useSelection } from '../app/router'
import type { Geodetic } from '../geometry/projection'
import { useWaylines } from '../plans/data'
import { useWaylineDesigner } from '../plans/waylineDesigner'
import { FlightPath } from './FlightPath'
import { usePalette } from './palette'
import { designedPath } from './plannedFlight'
import type { Site } from './site'

interface Props {
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The selected saved wayline as it flies (FR-WAY-09), in the accent colour with its waypoints; the
 * others stay out of the way, of a new one's design above all. The wayline open in the designer is
 * the designer's to draw.
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
      {shown.map((wayline) => (
        <FlightPath
          key={wayline.id}
          name={`wayline ${wayline.name}`}
          path={designedPath(wayline, origin, site)}
          colour={palette.accent}
          lineWidth={2.5}
          renderOrder={9}
          onClick={(event) => {
            event.stopPropagation()
            select({ kind: 'wayline', waylineId: wayline.id })
          }}
        />
      ))}
    </group>
  )
}
