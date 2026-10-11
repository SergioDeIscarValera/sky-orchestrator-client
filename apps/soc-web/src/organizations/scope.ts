import type { QueryClient, QueryKey } from '@tanstack/react-query'

const SCOPE = 'organization'

export const MEMBER_ORGANIZATIONS = 'member-organizations'

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
