import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useBackend } from '../backend/context'
import type { Geodetic } from '../geometry/projection'
import { useOrganization } from '../organizations/context'
import { organizationKey } from '../organizations/scope'
import { siteOf } from './site'

/**
 * The scene's frame (ADR-0014): the organization's baked site model, once loaded, its
 * ground, and the origin every local measure is taken from. With a site model the origin
 * is the model's, so the terrain, the aircraft and anything drawn share one frame even if
 * the organization has moved since the bake; without one, the organization's position;
 * null where Virtual Origen has none, and nothing can be placed on the map. The scene and
 * the editors read the same frame from here, so a vertex is measured where it is drawn.
 */
export function useSiteFrame() {
  const { organization } = useOrganization()
  const backend = useBackend()
  const { position } = organization
  const siteModel = useQuery({
    queryKey: organizationKey(organization.id, 'site-model'),
    queryFn: () => backend.siteModel(organization.id),
    enabled: position !== null,
    staleTime: Infinity,
  })
  const terrain = siteModel.data ?? null
  const origin = useMemo((): Geodetic | null => {
    if (terrain !== null) {
      const { latitude_deg: latitudeDeg, longitude_deg: longitudeDeg } = terrain.model.origin
      return { latitudeDeg, longitudeDeg }
    }
    return position === null
      ? null
      : { latitudeDeg: position.latitude, longitudeDeg: position.longitude }
  }, [terrain, position])
  const site = useMemo(() => siteOf(terrain), [terrain])
  return { siteModel, terrain, origin, site }
}
