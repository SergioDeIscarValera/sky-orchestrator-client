import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'

import { createGround, disposeGround, paintGround, paintSky } from './ground'
import { usePalette } from './palette'
import type { Site } from './site'

/** The flat ground and its grid, in the theme's colours, fading into the page. */
export function SceneContents({ site }: { readonly site: Site }) {
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
    invalidate()
  }, [ground, scene, palette, site, invalidate])

  return <primitive object={ground} />
}
