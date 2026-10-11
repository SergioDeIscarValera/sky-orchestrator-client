import { createContext, use } from 'react'

import type { Organization } from '../backend/backend'

export interface OrganizationChoice {
  readonly organization: Organization
  readonly organizations: readonly Organization[]
  readonly choose: (organizationId: string) => void
}

export const OrganizationContext = createContext<OrganizationChoice | null>(null)

export function useOrganization(): OrganizationChoice {
  const choice = use(OrganizationContext)
  if (choice === null) throw new Error('useOrganization outside an open organization')
  return choice
}
