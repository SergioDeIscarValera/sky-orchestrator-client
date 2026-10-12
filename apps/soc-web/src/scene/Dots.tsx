import { useEffect, useMemo } from 'react'
import { BufferGeometry, DataTexture, Float32BufferAttribute, RGBAFormat } from 'three'

const SIDE = 32

/** A round dot, white with a soft edge, for the points to be tinted with. */
function roundDot(): DataTexture {
  const pixels = new Uint8Array(SIDE * SIDE * 4)
  const middle = (SIDE - 1) / 2
  for (let row = 0; row < SIDE; row += 1) {
    for (let column = 0; column < SIDE; column += 1) {
      const distance = Math.hypot(row - middle, column - middle) / (SIDE / 2)
      const at = (row * SIDE + column) * 4
      pixels.fill(255, at, at + 3)
      pixels[at + 3] = Math.round(255 * Math.min(1, Math.max(0, (1 - distance) * 6)))
    }
  }
  const texture = new DataTexture(pixels, SIDE, SIDE, RGBAFormat)
  texture.needsUpdate = true
  return texture
}

let shared: DataTexture | null = null

/** Many points drawn as round dots of a fixed size on screen, over everything. */
export function Dots({
  points,
  colour,
  size,
}: {
  readonly points: readonly (readonly [number, number, number])[]
  readonly colour: string
  readonly size: number
}) {
  const geometry = useMemo(
    () =>
      new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute(
          points.flatMap((point) => [...point]),
          3,
        ),
      ),
    [points],
  )
  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry],
  )
  shared ??= roundDot()
  return (
    <points geometry={geometry} renderOrder={12}>
      <pointsMaterial
        color={colour}
        size={size}
        sizeAttenuation={false}
        map={shared}
        transparent
        alphaTest={0.5}
        depthTest={false}
      />
    </points>
  )
}
