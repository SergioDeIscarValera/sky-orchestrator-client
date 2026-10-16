import { useEffect, useRef } from 'react'

import { useSettings } from '../config/settings'
import { useFleets } from '../fleets/data'
import type { Geodetic } from '../geometry/projection'
import { useAssignments, useOperation } from '../operations/data'
import { aircraftKeysOf, fleetIdsOf } from '../operations/involvement'
import { useGeofences } from '../plans/data'
import { useTelemetryStore } from '../telemetry/context'
import { drawnAt } from './aircraft'
import { useCameraCommands, type ScenePoint } from './commands'
import { boundingBox } from './focus'
import { flatOf } from './groundTool'
import { plannedPath } from './plannedFlight'
import type { Site } from './site'

interface Props {
  /** The operation selected, or null: then nothing is framed. */
  readonly operationId: string | null
  readonly site: Site
  readonly origin: Geodetic
}

/**
 * The selected operation framed as a whole (FR-SCN-05), once: when it is selected and its data has
 * loaded, the camera is sent the box of its geofence ring, its planned flights and the positions its
 * aircraft hold then. A refetch does not refit the view; selecting another operation does.
 */
export function OperationFocus({ operationId, site, origin }: Props) {
  if (operationId === null) return null
  return <FocusOn key={operationId} operationId={operationId} site={site} origin={origin} />
}

/** Mounted per selection, so each selection starts unframed: the keyed remount is the once. */
function FocusOn({
  operationId,
  site,
  origin,
}: {
  readonly operationId: string
  readonly site: Site
  readonly origin: Geodetic
}) {
  const operation = useOperation(operationId)
  const assignments = useAssignments(operationId)
  const geofences = useGeofences()
  const fleets = useFleets()
  const tracks = useTelemetryStore()
  const settings = useSettings()
  const framed = useRef(false)
  // The camera takes the fit only once it is mounted: a command sent before that is lost (Controls).
  const cameraReady = useCameraCommands((state) => state.ready)
  const geofenceId = operation.data?.geofenceId ?? null
  const loaded =
    operation.data !== undefined &&
    !assignments.isPending &&
    !geofences.isPending &&
    !fleets.isPending

  useEffect(() => {
    if (framed.current || !loaded || !cameraReady) return
    const assigned = assignments.data ?? []
    const polygon = geofences.data?.find(({ id }) => id === geofenceId)?.polygon ?? []
    const points: ScenePoint[] = []
    // The geofence's ring lies on the ground, as the scene draws it.
    for (const vertex of polygon) {
      const { x, z } = flatOf(origin, vertex)
      points.push({ x, y: site.ground(x, z), z })
    }
    for (const assignment of assigned) {
      const path = plannedPath(assignment, origin, site)
      if (path !== null) for (const [x, y, z] of path.points) points.push({ x, y, z })
    }
    // An aircraft lost to the telemetry is not where it is now, so it does not frame the operation.
    const now = performance.now()
    for (const key of aircraftKeysOf(fleetIdsOf(assigned), fleets.data ?? [])) {
      const track = tracks.getState().tracks.get(key)
      const drawn = track === undefined ? null : drawnAt(track, origin, now, settings, site.ground)
      if (drawn !== null && drawn.freshness !== 'lost') {
        const { x, y, z } = drawn.placement
        points.push({ x, y, z })
      }
    }
    const box = boundingBox(points)
    // Nothing read yet to frame: the view stays, and a later read tries again.
    if (box === null) return
    framed.current = true
    useCameraCommands.getState().fit(box)
  }, [
    loaded,
    cameraReady,
    geofenceId,
    assignments.data,
    geofences.data,
    fleets.data,
    origin,
    site,
    settings,
    tracks,
  ])

  return null
}
