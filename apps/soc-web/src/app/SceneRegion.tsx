import { lazy, Suspense, useState } from 'react'

import { useOrganization } from '../organizations/context'
import { FLAT_SITE } from '../scene/site'
import { SceneBoundary, SceneMessage } from '../scene/SceneBoundary'
import { StatsOverlay } from '../scene/StatsOverlay'
import { supportsWebGl2, wantsStats } from '../scene/webgl'

const Scene = lazy(() => import('../scene/Scene'))

/** The scene stays mounted for the whole session; the panels float over it (FR-SCN-01). */
export function SceneRegion() {
  const { organization } = useOrganization()
  const [drawable] = useState(supportsWebGl2)
  const [stats] = useState(() => wantsStats())

  return (
    <main aria-label="Scene" className="absolute inset-0">
      {drawable ? (
        <SceneBoundary>
          <Suspense fallback={null}>
            <Scene site={FLAT_SITE} organizationId={organization.id} />
          </Suspense>
        </SceneBoundary>
      ) : (
        <SceneMessage>
          This browser cannot draw the scene: SOC needs WebGL 2, as in the latest Chrome, Edge or
          Firefox.
        </SceneMessage>
      )}
      <p
        role="note"
        className="rounded-pill bg-info-subtle text-info-emphasis pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 px-4 py-1.5 text-xs"
      >
        {organization.position === null
          ? `${organization.name} has no position in Virtual Origen: the scene is not on the map.`
          : `No site model for ${organization.name} yet: the ground is flat.`}
      </p>
      {stats && <StatsOverlay />}
    </main>
  )
}
