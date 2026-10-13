import type { QueryClient, QueryKey } from '@tanstack/react-query'

const SCOPE = 'organization'

export const MEMBER_ORGANIZATIONS = 'member-organizations'

/** The query names of an organization's geofences and waylines, under its key (IR-GEO, IR-WAY). */
export const GEOFENCES = 'geofences'
export const WAYLINES = 'waylines'

/** The query names of an organization's stacks, operations and their parts (IR-STK, IR-OPS). */
export const STACKS = 'stacks'
export const OPERATIONS = 'operations'
export const ASSIGNMENTS = 'assignments'
export const OPERATORS = 'operators'
export const MEMBERS = 'members'
export const CHECKS = 'checks'
export const EVENTS = 'events'
export const REQUESTS = 'requests'
export const FLIGHTS = 'flights'
export const FLIGHT_STATES = 'flight-states'
export const COMMAND_INTENTS = 'command-intents'

/** Every query about one organization's data starts with this key. */
export function organizationKey(organizationId: string, ...rest: readonly unknown[]): QueryKey {
  return [SCOPE, organizationId, ...rest]
}

/** Drops what was fetched for every other organization, so none of it can be shown (FR-AUT-02). */
export function forgetOtherOrganizations(queryClient: QueryClient, organizationId: string): void {
  queryClient.removeQueries({
    predicate: ({ queryKey }) => queryKey[0] === SCOPE && queryKey[1] !== organizationId,
  })
}
