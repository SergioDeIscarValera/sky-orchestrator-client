import { Canvas } from '@react-three/fiber'

import { useSelect, useView } from '../app/router'

import type { Geodetic } from '../geometry/projection'
import { Aircraft } from './Aircraft'
import type { LoadedSite } from './siteModel'
import { Terrain } from './Terrain'
import type { Site } from './site'
import { CANVAS_SETTINGS } from './canvas'
import { Controls } from './Controls'
import { GeofenceEditing } from './GeofenceEditing'
import { useGroundTool } from './groundTool'
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
  const select = useSelect()
  const { panel } = useView()
  return (
    <Canvas
      {...CANVAS_SETTINGS}
      dpr={[...CANVAS_SETTINGS.dpr]}
      // A click on the ground, not a drag, clears the selection, or goes to the editor
      // holding the ground; an aircraft's click selects it.
      onPointerMissed={(event) => {
        if (event.button !== 0) return
        const { use } = useGroundTool.getState()
        if (use === null) select(null)
        else use(event)
      }}
    >
      <SceneContents site={site} flat={terrain === null} />
      {terrain !== null && <Terrain site={terrain} />}
      <Aircraft origin={origin} site={site} />
      {origin !== null && panel === 'geofences' && <GeofenceEditing site={site} origin={origin} />}
      <Controls site={site} organizationId={organizationId} />
      <Meter />
    </Canvas>
  )
}
