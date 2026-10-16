import { Canvas } from '@react-three/fiber'
import { Raycaster } from 'three'

import { useSelect, useSelection, useView } from '../app/router'

import type { Geodetic } from '../geometry/projection'
import { Aircraft } from './Aircraft'
import type { LoadedSite } from './siteModel'
import { Terrain } from './Terrain'
import type { Site } from './site'
import { CANVAS_SETTINGS } from './canvas'
import { Controls } from './Controls'
import { GeofenceEditing } from './GeofenceEditing'
import { FleetOperation } from './FleetOperation'
import { Geofences } from './Geofences'
import { OperationDrawing } from './OperationDrawing'
import { OperationFocus } from './OperationFocus'
import { WaylineDesigning } from './WaylineDesigning'
import { Waylines } from './Waylines'
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

/** A wide line is picked this many pixels either side of it: a geofence's outline is a target. */
const LINE_PICK_PX = 8
const RAYCASTER = { params: { ...new Raycaster().params, Line2: { threshold: LINE_PICK_PX } } }

/** The one persistent scene (FR-SCN-01), loaded apart from the rest (NFR-PERF-05). */
export default function Scene({ site, organizationId, origin, terrain }: Props) {
  const select = useSelect()
  const selection = useSelection()
  const { panel } = useView()
  const operationId = selection?.kind === 'operation' ? selection.operationId : null
  // A selected aircraft, or its fleet, shows its flight when its fleet is in an underway operation.
  const fleetSelected = selection?.kind === 'fleet' || selection?.kind === 'device'
  return (
    <Canvas
      {...CANVAS_SETTINGS}
      dpr={[...CANVAS_SETTINGS.dpr]}
      raycaster={RAYCASTER}
      // A click on the ground, not a drag, clears the selection, or goes to the editor
      // holding the ground; an aircraft's click selects it.
      onPointerMissed={(event) => {
        if (event.button !== 0) return
        const { use } = useGroundTool.getState()
        if (use === null) {
          select(null)
          return
        }
        // A click on the map takes the focus from the panel, so Enter finishes what is
        // drawn rather than pressing the tool's button again.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        use(event)
      }}
    >
      <SceneContents site={site} flat={terrain === null} />
      {terrain !== null && <Terrain site={terrain} />}
      <Aircraft origin={origin} site={site} />
      {origin !== null && <Geofences site={site} origin={origin} />}
      {origin !== null && panel === 'geofences' && <GeofenceEditing site={site} origin={origin} />}
      {origin !== null && <Waylines site={site} origin={origin} />}
      {origin !== null && (
        <OperationDrawing operationId={operationId} site={site} origin={origin} />
      )}
      {origin !== null && <OperationFocus operationId={operationId} site={site} origin={origin} />}
      {origin !== null && fleetSelected && (
        <FleetOperation selection={selection} site={site} origin={origin} />
      )}
      {origin !== null && panel === 'waylines' && <WaylineDesigning site={site} origin={origin} />}
      <Controls site={site} organizationId={organizationId} />
      <Meter />
    </Canvas>
  )
}
