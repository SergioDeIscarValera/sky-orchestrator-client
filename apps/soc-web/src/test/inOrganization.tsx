import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { AccountContext } from '../account/account'
import type {
  Account,
  EndReason,
  Operation,
  OperationDraft,
  OperationState,
  Operator,
  Organization,
} from '../backend/backend'
import { BackendContext } from '../backend/context'
import { OrganizationContext } from '../organizations/context'
import type { FakeBackend } from './FakeBackend'
import { NORTH } from './FakeBackend'
import { LiveTopics } from './LiveTopics'
import { quietQueryClient } from './render'

interface Membership {
  readonly backend: FakeBackend
  /** The signed-in account, the one the backend answers for. */
  readonly account: Account
  /** The open organization, with the role this member holds in it; North when not given. */
  readonly organization?: Organization
  readonly queryClient?: QueryClient
}

/**
 * Renders a panel as the console holds it: under the backend and the signed-in account, in an open
 * organization, with its live topics kept current.
 */
export function renderInOrganization(
  ui: ReactNode,
  { backend, account, organization = NORTH, queryClient = quietQueryClient() }: Membership,
) {
  const choice = { organization, organizations: [organization], choose: () => undefined }
  const view = render(
    <BackendContext value={backend}>
      <QueryClientProvider client={queryClient}>
        <AccountContext value={account}>
          <OrganizationContext value={choice}>
            <LiveTopics />
            {ui}
          </OrganizationContext>
        </AccountContext>
      </QueryClientProvider>
    </BackendContext>,
  )
  return { ...view, backend, queryClient, user: userEvent.setup({ delay: null }) }
}

const DRAFT: OperationDraft = {
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
}

/** The moves from a draft to each state, every one of them a move the lifecycle allows (FR-OPS-02). */
const LEG: readonly OperationState[] = [
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
]

const PATH: Readonly<Record<OperationState, readonly OperationState[]>> = {
  draft: [],
  planned: LEG.slice(0, 1),
  preparing: LEG.slice(0, 2),
  simulating: LEG.slice(0, 3),
  simulated: LEG.slice(0, 4),
  ready: LEG.slice(0, 5),
  launching: LEG.slice(0, 6),
  in_flight: LEG.slice(0, 7),
  paused: [...LEG, 'paused'],
  returning: [...LEG, 'returning'],
  completed: [...LEG, 'returning', 'completed'],
  aborted: [...LEG, 'returning', 'aborted'],
  failed: [...LEG, 'returning', 'failed'],
  cancelled: ['cancelled'],
}

/** The reasons an end needs beyond its state: a stop aborts, a fault fails. */
const END: Partial<Record<OperationState, EndReason>> = {
  aborted: 'operator_stop',
  failed: 'aircraft_fault',
}

/**
 * An operation of North in a state, made the way the database makes it: created, then moved by the
 * fake's own moves, its log written as it goes. Its pilots are named by their account ids.
 */
export async function operationIn(
  backend: FakeBackend,
  state: OperationState,
  pilots: readonly string[] = [],
): Promise<Operation> {
  const created = await backend.createOperation(NORTH.id, DRAFT)
  const operators: Operator[] = pilots.map((profileId) => ({
    operationId: created.id,
    profileId,
    role: 'pilot',
  }))
  backend.operatorRows.set(created.id, operators)
  let current = created
  for (const step of PATH[state]) {
    current = backend.moveOperation(created.id, step, END[step] ?? null)
  }
  return current
}
