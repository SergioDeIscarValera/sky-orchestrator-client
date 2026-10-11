import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'

import { createGround, disposeGround, paintGround, paintSky, showGround } from './ground'
import { usePalette } from './palette'
import type { Site } from './site'

/**
 * The flat ground and its grid, in the theme's colours, fading into the page; hidden
 * under a baked terrain, which brings its own ground.
 */
export function SceneContents({ site, flat }: { readonly site: Site; readonly flat: boolean }) {
  const palette = usePalette()
  const scene = useThree((state) => state.scene)
  const invalidate = useThree((state) => state.invalidate)
  const ground = useMemo(() => createGround(site), [site])

  useEffect(
    () => () => {
      disposeGround(ground)
    },
    [ground],
  )

  useLayoutEffect(() => {
    paintGround(ground, palette)
    paintSky(scene, palette, site)
    showGround(ground, flat)
    invalidate()
  }, [ground, scene, palette, site, flat, invalidate])

  return <primitive object={ground} />
}
