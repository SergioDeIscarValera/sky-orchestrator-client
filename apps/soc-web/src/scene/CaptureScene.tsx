import { useStore, useThree, type RootStore } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Scene } from 'three'

/**
 * Hands a test's three.js root out of the tree, where the scene's own components read it: its scene, and
 * its store, which runs a frame by hand.
 */
export function CaptureScene({
  onMounted,
}: {
  readonly onMounted: (scene: Scene, store: RootStore) => void
}) {
  const scene = useThree((state) => state.scene)
  const store = useStore()
  useEffect(() => {
    onMounted(scene, store)
  }, [onMounted, scene, store])
  return null
}
