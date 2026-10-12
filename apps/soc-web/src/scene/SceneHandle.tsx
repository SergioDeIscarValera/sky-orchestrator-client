import { Html } from '@react-three/drei'

import { HandleButton, type HandleButtonProps } from './HandleButton'

/** A handle in the scene, over the point `at`: an editor's button, above the panels' layer. */
export function SceneHandle({
  at,
  ...button
}: { readonly at: readonly [number, number, number] } & HandleButtonProps) {
  return (
    <Html position={[...at]} center zIndexRange={[30, 21]}>
      <HandleButton {...button} />
    </Html>
  )
}
