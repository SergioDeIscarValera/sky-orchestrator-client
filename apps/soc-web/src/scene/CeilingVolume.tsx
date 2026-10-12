import { Html, Line } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { BufferGeometry, DoubleSide, Float32BufferAttribute } from 'three'

import { formatLength } from '../plans/format'
import { ceilingWalls } from './ceiling'
import { draped, type Flat } from './drape'
import type { Site } from './site'

/** As the outlines', so the walls stand on the line drawn on the ground. */
const LIFT_M = 1

interface Props {
  readonly ring: readonly Flat[]
  readonly site: Site
  /** Above the takeoff point (ADR-0014); null or not above zero draws nothing. */
  readonly ceilingM: number | null
  readonly colour: string
}

/**
 * A geofence's volume (FR-GEO-01): faint walls from its outline up to its ceiling, the
 * ceiling's ring and a post at each vertex, and the height named above the first vertex,
 * so the ceiling is seen while it is drawn and when it is chosen.
 */
export function CeilingVolume({ ring, site, ceilingM, colour }: Props) {
  const step = site.spacingM === null ? Infinity : site.spacingM / 2
  const shown = ceilingM !== null && ceilingM > LIFT_M && ring.length >= 3
  const walls = useMemo(() => {
    const geometry = new BufferGeometry()
    if (shown) {
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(ceilingWalls(ring, site.ground, step, LIFT_M, ceilingM), 3),
      )
    }
    return geometry
  }, [shown, ring, site, step, ceilingM])
  useEffect(
    () => () => {
      walls.dispose()
    },
    [walls],
  )
  if (!shown) return null
  const [first] = ring
  return (
    <group>
      <mesh geometry={walls} renderOrder={6}>
        <meshBasicMaterial
          color={colour}
          transparent
          opacity={0.08}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Line
        points={draped(ring, site.ground, step, ceilingM, true)}
        color={colour}
        lineWidth={1.5}
        transparent
        opacity={0.7}
        depthTest={false}
        renderOrder={7}
      />
      {ring.map(({ x, z }, index) => (
        <Line
          key={`post-${String(index)}`}
          points={[
            [x, site.ground(x, z) + LIFT_M, z],
            [x, site.ground(x, z) + ceilingM, z],
          ]}
          color={colour}
          lineWidth={1}
          transparent
          opacity={0.5}
          depthTest={false}
          renderOrder={7}
        />
      ))}
      {first !== undefined && (
        <Html
          position={[first.x, site.ground(first.x, first.z) + ceilingM, first.z]}
          center
          zIndexRange={[19, 0]}
          className="pointer-events-none"
        >
          <span className="rounded-pill bg-surface text-heading shadow-card block -translate-y-4 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums">
            {formatLength(ceilingM)}
          </span>
        </Html>
      )}
    </group>
  )
}
