import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  GeofenceChanges,
  GeofenceDraft,
  WaylineChanges,
  WaylineDraft,
} from '../backend/backend'
import { useBackend } from '../backend/context'
import { useOrganization } from '../organizations/context'
import { GEOFENCES, WAYLINES, organizationKey } from '../organizations/scope'

export function useGeofences() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, GEOFENCES),
    queryFn: () => backend.geofences(organization.id),
  })
}

export function useWaylines() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, WAYLINES),
    queryFn: () => backend.waylines(organization.id),
  })
}

/** Each write settles once its list is read again, so what it changed is on screen by then. */
function usePlanWrite<Input, Output>(
  name: string,
  write: (organizationId: string, input: Input) => Promise<Output>,
) {
  const queryClient = useQueryClient()
  const { organization } = useOrganization()
  return useMutation({
    mutationFn: (input: Input) => write(organization.id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: organizationKey(organization.id, name) }),
  })
}

export function useCreateGeofence() {
  const backend = useBackend()
  return usePlanWrite(GEOFENCES, (organizationId, draft: GeofenceDraft) =>
    backend.createGeofence(organizationId, draft),
  )
}

export function useChangeGeofence() {
  const backend = useBackend()
  return usePlanWrite(
    GEOFENCES,
    (_organizationId, input: { id: string; changes: GeofenceChanges }) =>
      backend.changeGeofence(input.id, input.changes),
  )
}

export function useRetireGeofence() {
  const backend = useBackend()
  return usePlanWrite(GEOFENCES, (_organizationId, geofenceId: string) =>
    backend.retireGeofence(geofenceId),
  )
}

export function useCreateWayline() {
  const backend = useBackend()
  return usePlanWrite(WAYLINES, (organizationId, draft: WaylineDraft) =>
    backend.createWayline(organizationId, draft),
  )
}

export function useChangeWayline() {
  const backend = useBackend()
  return usePlanWrite(WAYLINES, (_organizationId, input: { id: string; changes: WaylineChanges }) =>
    backend.changeWayline(input.id, input.changes),
  )
}

export function useRetireWayline() {
  const backend = useBackend()
  return usePlanWrite(WAYLINES, (_organizationId, waylineId: string) =>
    backend.retireWayline(waylineId),
  )
}
