import { Canvas } from '@react-three/fiber'

import type { Site } from './site'
import { CANVAS_SETTINGS } from './canvas'
import { Controls } from './Controls'
import { Meter } from './Meter'
import { SceneContents } from './SceneContents'

interface Props {
  readonly site: Site
  readonly organizationId: string
}

/** The one persistent scene (FR-SCN-01), loaded apart from the rest (NFR-PERF-05). */
export default function Scene({ site, organizationId }: Props) {
  return (
    <Canvas {...CANVAS_SETTINGS} dpr={[...CANVAS_SETTINGS.dpr]}>
      <SceneContents site={site} />
      <Controls site={site} organizationId={organizationId} />
      <Meter />
    </Canvas>
  )
}
