import { lazy, Suspense, useState } from 'react'

import { useOrganization } from '../organizations/context'
import { SceneBoundary, SceneMessage } from '../scene/SceneBoundary'
import { useSiteFrame } from '../scene/siteFrame'
import { StatsOverlay } from '../scene/StatsOverlay'
import { supportsWebGl2, wantsStats } from '../scene/webgl'

const Scene = lazy(() => import('../scene/Scene'))

/** The scene stays mounted for the whole session; the panels float over it (FR-SCN-01). */
export function SceneRegion() {
  const { organization } = useOrganization()
  const [drawable] = useState(supportsWebGl2)
  const [stats] = useState(() => wantsStats())
  const { position } = organization
  const { siteModel, terrain, origin, site } = useSiteFrame()

  const note =
    position === null
      ? `${organization.name} has no position in Virtual Origen: the scene is not on the map.`
      : siteModel.isError
        ? `The site model of ${organization.name} cannot be loaded (${siteModel.error.message}): the ground is flat.`
        : siteModel.isSuccess && terrain === null
          ? `No site model for ${organization.name} yet: the ground is flat.`
          : null

  // Its own stacking context: what the scene lays over the canvas, labels and handles,
  // stays under the panels whatever its z-index.
  return (
    <main aria-label="Scene" className="absolute inset-0 isolate">
      {drawable ? (
        <SceneBoundary>
          <Suspense fallback={null}>
            <Scene site={site} organizationId={organization.id} origin={origin} terrain={terrain} />
          </Suspense>
        </SceneBoundary>
      ) : (
        <SceneMessage>
          This browser cannot draw the scene: SOC needs WebGL 2, as in the latest Chrome, Edge or
          Firefox.
        </SceneMessage>
      )}
      {note !== null && (
        <p
          role="note"
          className="rounded-pill bg-info-subtle text-info-emphasis pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 px-4 py-1.5 text-xs"
        >
          {note}
        </p>
      )}
      {terrain !== null && (
        <p className="rounded-pill bg-surface text-muted pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 text-[11px]">
          {terrain.model.attribution}
        </p>
      )}
      {stats && <StatsOverlay />}
    </main>
  )
}
