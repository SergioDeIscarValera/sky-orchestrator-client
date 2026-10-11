import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useAccount } from '../account/account'
import { SignOut } from '../account/SignOut'
import { BackendError } from '../backend/backend'
import { useBackend } from '../backend/context'
import { Card, Waiting } from '../app/Centered'
import { ALERT, PRIMARY_BUTTON } from '../app/styles'
import { OrganizationContext } from './context'
import { OrganizationPicker } from './OrganizationPicker'
import { rememberOrganization, rememberedOrganization } from './remembered'
import { MEMBER_ORGANIZATIONS, forgetOtherOrganizations } from './scope'

/** Nothing below opens until one organization is chosen (FR-AUT-02). */
export function OrganizationGate({ children }: { readonly children: ReactNode }) {
  const account = useAccount()
  const backend = useBackend()
  const queryClient = useQueryClient()
  const [chosenId, setChosenId] = useState(() => rememberedOrganization(account.userId))
  const query = useQuery({
    queryKey: [MEMBER_ORGANIZATIONS, account.userId],
    queryFn: () => backend.memberOrganizations(),
  })

  if (query.isPending) return <Waiting label="Loading your organizations…" />
  if (query.isError) {
    return (
      <Card title="Your organizations cannot be loaded">
        <p role="alert" className={`${ALERT} mt-5`}>
          {explain(query.error)}
        </p>
        <div className="mt-6 flex items-center justify-between">
          <SignOut />
          <button
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RotateCw size={16} aria-hidden />
            Try again
          </button>
        </div>
      </Card>
    )
  }

  const organizations = query.data
  if (organizations.length === 0) {
    return (
      <Card title="No organization to open">
        <p className="mt-2 text-sm">
          {account.email} is not a member of any organization. Organizations and their members are
          managed in Virtual Origen.
        </p>
        <div className="mt-6">
          <SignOut />
        </div>
      </Card>
    )
  }

  const choose = (organizationId: string) => {
    rememberOrganization(account.userId, organizationId)
    forgetOtherOrganizations(queryClient, organizationId)
    setChosenId(organizationId)
  }
  const organization =
    organizations.find(({ id }) => id === chosenId) ??
    (organizations.length === 1 ? organizations[0] : undefined)

  if (organization === undefined) {
    return <OrganizationPicker organizations={organizations} onChoose={choose} />
  }
  return (
    <OrganizationContext value={{ organization, organizations, choose }}>
      {children}
    </OrganizationContext>
  )
}

function explain(error: Error): string {
  if (error instanceof BackendError && error.code === 'PGRST106') {
    return 'Supabase does not serve schema soc yet: add soc to PGRST_DB_SCHEMAS on the server (DEP-21).'
  }
  if (error instanceof BackendError && error.code === 'PGRST202') {
    return "soc.member_organizations does not exist: apply SOC's database migrations."
  }
  return error.message
}
