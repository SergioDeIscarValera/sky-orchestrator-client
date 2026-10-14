import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import type { FleetChanges, FleetDraft, StateEvent } from '../backend/backend'
import { useBackend } from '../backend/context'
import { openLive } from '../backend/live'
import { placeRow } from '../operations/data'
import { useOrganization } from '../organizations/context'
import {
  ASSIGNMENTS,
  COMMAND_INTENTS,
  FLIGHT_STATES,
  FLIGHTS,
  GEOFENCES,
  OPERATIONS,
  OPERATORS,
  REQUESTS,
  STACKS,
  WAYLINES,
  organizationKey,
} from '../organizations/scope'

/** The catalogue changes only with a migration, so one read lasts the session (IR-MOD). */
export const AIRCRAFT_MODELS = ['aircraft-models'] as const

const DEVICES = 'devices'
const FLEETS = 'fleets'

/**
 * The organization's queries each change on its state topic makes stale; a join, all of them. A
 * log entry and a check arrive whole, so they are written into their cache instead (placeRow).
 */
const STALE: Readonly<Record<StateEvent['kind'], readonly string[] | 'all' | 'written'>> = {
  joined: 'all',
  stack: [DEVICES, STACKS],
  device: [DEVICES],
  fleet: [FLEETS],
  command_intent: [COMMAND_INTENTS],
  geofence: [GEOFENCES],
  wayline: [WAYLINES],
  operation: [OPERATIONS, ASSIGNMENTS, OPERATORS],
  flight: [FLIGHTS],
  flight_state: [FLIGHT_STATES],
  operation_event: 'written',
  transition_request: [REQUESTS],
  operation_check: 'written',
}

export async function staleAfter(
  queryClient: QueryClient,
  organizationId: string,
  event: StateEvent,
): Promise<void> {
  const names = STALE[event.kind]
  if (names === 'written') return placeRow(queryClient, organizationId, event)
  const keys =
    names === 'all'
      ? [organizationKey(organizationId)]
      : names.map((name) => organizationKey(organizationId, name))
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

/** Keeps what the console read of the open organization current while it is open (ADR-0007). */
export function useLiveState(): void {
  const backend = useBackend()
  const queryClient = useQueryClient()
  const { organization } = useOrganization()

  useEffect(
    () =>
      openLive('state', () =>
        backend.onState(organization.id, (event) => {
          void staleAfter(queryClient, organization.id, event)
        }),
      ),
    [backend, queryClient, organization.id],
  )
}

export function useAircraftModels() {
  const backend = useBackend()
  return useQuery({
    queryKey: AIRCRAFT_MODELS,
    queryFn: () => backend.aircraftModels(),
    staleTime: Infinity,
  })
}

/** The aircraft the organization's stacks have announced, registered in a fleet or not. */
export function useDevices() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, DEVICES),
    queryFn: () => backend.devices(organization.id),
  })
}

export function useFleets() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, FLEETS),
    queryFn: () => backend.fleets(organization.id),
  })
}

/** Each write settles once the fleets are read again, so what it changed is on screen by then. */
function useFleetWrite<Input, Output>(
  write: (organizationId: string, input: Input) => Promise<Output>,
) {
  const queryClient = useQueryClient()
  const { organization } = useOrganization()
  return useMutation({
    mutationFn: (input: Input) => write(organization.id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: organizationKey(organization.id, FLEETS) }),
  })
}

export function useRegisterFleet() {
  const backend = useBackend()
  return useFleetWrite((organizationId, draft: FleetDraft) =>
    backend.registerFleet(organizationId, draft),
  )
}

export function useChangeFleet() {
  const backend = useBackend()
  return useFleetWrite((_organizationId, input: { id: string; changes: FleetChanges }) =>
    backend.changeFleet(input.id, input.changes),
  )
}

export function useRetireFleet() {
  const backend = useBackend()
  return useFleetWrite((_organizationId, fleetId: string) => backend.retireFleet(fleetId))
}
