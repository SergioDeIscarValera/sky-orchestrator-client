import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { SRGBColorSpace, TextureLoader, type Texture } from 'three'

import { usePalette } from './palette'
import type { LoadedSite } from './siteModel'
import { createTerrain, disposeTerrain, paintTerrain } from './terrain'

/** The organization's terrain, from its baked site model (FR-SCN-02, ADR-0018). */
export function Terrain({ site }: { readonly site: LoadedSite }) {
  const palette = usePalette()
  const invalidate = useThree((state) => state.invalidate)
  const gl = useThree((state) => state.gl)
  const [imagery, setImagery] = useState<Texture | null>(null)

  useEffect(() => {
    let current = true
    new TextureLoader().load(site.imageryUrl, (loaded) => {
      if (!current) {
        loaded.dispose()
        return
      }
      // The imagery holds sRGB-encoded luminance: decoded on sampling, mixed linear.
      loaded.colorSpace = SRGBColorSpace
      loaded.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy())
      setImagery(loaded)
      invalidate()
    })
    return () => {
      current = false
    }
  }, [site.imageryUrl, gl, invalidate])

  useEffect(
    () => () => {
      imagery?.dispose()
    },
    [imagery],
  )

  const terrain = useMemo(
    () => (imagery === null ? null : createTerrain(site, imagery)),
    [site, imagery],
  )

  useEffect(
    () => () => {
      if (terrain !== null) disposeTerrain(terrain)
    },
    [terrain],
  )

  useLayoutEffect(() => {
    if (terrain === null) return
    paintTerrain(terrain.material, palette)
    invalidate()
  }, [terrain, palette, invalidate])

  return terrain === null ? null : <primitive object={terrain.lod} />
}
