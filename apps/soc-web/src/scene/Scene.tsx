import { Canvas } from '@react-three/fiber'

import type { Geodetic } from '../geometry/projection'
import { Aircraft } from './Aircraft'
import type { LoadedSite } from './siteModel'
import { Terrain } from './Terrain'
import type { Site } from './site'
import { CANVAS_SETTINGS } from './canvas'
import { Controls } from './Controls'
import { Meter } from './Meter'
import { SceneContents } from './SceneContents'

interface Props {
  readonly site: Site
  readonly organizationId: string
  /** The organization's position, the scene's origin; null where Virtual Origen has none. */
  readonly origin: Geodetic | null
  /** The organization's baked site model, or null for the flat ground. */
  readonly terrain: LoadedSite | null
}

/** The one persistent scene (FR-SCN-01), loaded apart from the rest (NFR-PERF-05). */
export default function Scene({ site, organizationId, origin, terrain }: Props) {
  return (
    <Canvas {...CANVAS_SETTINGS} dpr={[...CANVAS_SETTINGS.dpr]}>
      <SceneContents site={site} flat={terrain === null} />
      {terrain !== null && <Terrain site={terrain} />}
      <Aircraft origin={origin} site={site} terrain={terrain} />
      <Controls site={site} organizationId={organizationId} />
      <Meter />
    </Canvas>
  )
}
