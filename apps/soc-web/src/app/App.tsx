import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { AccountContext, useAccountState } from '../account/account'
import { SignIn } from '../account/SignIn'
import type { Backend } from '../backend/backend'
import { BackendContext, useBackend } from '../backend/context'
import { OrganizationGate } from '../organizations/OrganizationGate'
import { Waiting } from './Centered'
import { Shell } from './Shell'

interface Props {
  readonly backend: Backend
  readonly queryClient: QueryClient
}

export function App({ backend, queryClient }: Props) {
  return (
    <BackendContext value={backend}>
      <QueryClientProvider client={queryClient}>
        <Session />
      </QueryClientProvider>
    </BackendContext>
  )
}

function Session() {
  const state = useAccountState(useBackend())
  const queryClient = useQueryClient()

  useEffect(() => {
    if (state.status === 'signed-out') queryClient.clear()
  }, [state.status, queryClient])

  switch (state.status) {
    case 'restoring':
      return <Waiting label="Restoring your session…" />
    case 'signed-out':
      return <SignIn />
    case 'signed-in':
      return (
        <AccountContext value={state.account}>
          <OrganizationGate key={state.account.userId}>
            <Shell />
          </OrganizationGate>
        </AccountContext>
      )
  }
}
