import { createContext, use, useEffect, useState } from 'react'

import type { Account, Backend } from '../backend/backend'

export type AccountState =
  | { readonly status: 'restoring' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly account: Account }

export function useAccountState(backend: Backend): AccountState {
  const [state, setState] = useState<AccountState>({ status: 'restoring' })

  useEffect(
    () =>
      backend.onAccountChange((account) => {
        setState((current) => {
          if (account === null) return { status: 'signed-out' }
          const same =
            current.status === 'signed-in' &&
            current.account.userId === account.userId &&
            current.account.email === account.email
          return same ? current : { status: 'signed-in', account }
        })
      }),
    [backend],
  )

  return state
}

export const AccountContext = createContext<Account | null>(null)

export function useAccount(): Account {
  const account = use(AccountContext)
  if (account === null) throw new Error('useAccount outside a signed-in session')
  return account
}
