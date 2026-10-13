import { act, screen, waitFor, within } from '@testing-library/react'

import {
  BackendError,
  type Operation,
  type OperationState,
  type TransitionStatus,
} from '../backend/backend'
import { FakeBackend, NEIGHBOUR, NORTH, PILOT } from '../test/FakeBackend'
import { operationIn, renderInOrganization } from '../test/inOrganization'
import { OperationActions } from './OperationActions'

/** The moves each state offers, in the order the console shows them (FR-OPS-02). */
const TABLE: Readonly<Record<OperationState, readonly string[]>> = {
  draft: ['Plan', 'Cancel'],
  planned: ['Prepare', 'Cancel'],
  preparing: ['Simulate', 'Stop preparing', 'Cancel'],
  simulating: [],
  simulated: ['Cancel'],
  ready: ['Launch', 'Cancel'],
  launching: [],
  in_flight: ['Stop'],
  paused: ['Stop'],
  returning: [],
  completed: [],
  aborted: [],
  failed: [],
  cancelled: [],
}

const STATES: readonly OperationState[] = [
  'draft',
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
  'completed',
  'aborted',
  'failed',
  'cancelled',
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Role = 'owner' | 'editor' | 'viewer'

function renderMoves(
  operation: Operation,
  backend: FakeBackend,
  { account = PILOT, role = 'owner' }: { account?: typeof PILOT; role?: Role } = {},
) {
  return renderInOrganization(<OperationActions operationId={operation.id} />, {
    backend,
    account,
    organization: { ...NORTH, role },
  })
}

/** The panel read: its waiting line gone, with its moves, or with none. */
async function loaded() {
  await waitFor(() => {
    expect(screen.queryByText('Loading the actions…')).toBeNull()
  })
}

/** The names of the moves shown, in the order shown. */
function moves(): (string | null)[] {
  return screen.queryAllByRole('button').map((move) => move.textContent)
}

const move = (name: string) => screen.getByRole('button', { name })

/** Decides the operation's newest request, as soc-operations does: its outcome, with its reasons. */
async function decide(
  backend: FakeBackend,
  operation: Operation,
  to: TransitionStatus,
  reasons: string[] = [],
) {
  const [request] = await backend.requests(operation.id)
  if (request === undefined) throw new Error('no request was asked')
  act(() => {
    backend.settleRequest(request.id, to, reasons)
  })
}

describe('the moves a member may ask an operation (FR-OPS-02, FR-OPS-09)', () => {
  it.each(STATES)('offers an operation in %s the moves of its state, in order', async (state) => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, state, [PILOT.userId])
    renderMoves(operation, backend)
    await loaded()
    expect(moves()).toEqual(TABLE[state])
  })

  it('reads the operation and its operators before it shows a move', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    renderMoves(operation, backend)
    expect(screen.getByText('Loading the actions…')).toBeVisible()
    await loaded()
  })

  it('shows an editor who is not a pilot the flight moves disabled, saying so as a tooltip', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'editor' }])
    const operation = await operationIn(backend, 'ready')
    renderMoves(operation, backend, { account: NEIGHBOUR, role: 'editor' })
    await loaded()
    const launch = move('Launch')
    expect(launch).toHaveAttribute('aria-disabled', 'true')
    expect(launch).toHaveAccessibleDescription('Pilots only')
    expect(launch).toHaveAttribute('title', 'Pilots only')
    expect(move('Cancel')).toHaveAttribute('aria-disabled', 'false')
    expect(move('Cancel')).toHaveAccessibleDescription('')
  })

  it('lets a pilot who is an owner ask the flight moves, with no reason shown', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'ready', [PILOT.userId])
    renderMoves(operation, backend)
    await loaded()
    expect(move('Launch')).toBeEnabled()
    expect(move('Launch')).toHaveAttribute('aria-disabled', 'false')
    expect(move('Launch')).toHaveAccessibleDescription('')
  })

  it('shows a viewer every move disabled, saying Editors only, and sends none of them', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing', [PILOT.userId])
    backend.memberships.set(PILOT.userId, [{ ...NORTH, role: 'viewer' }])
    const asks = vi.spyOn(backend, 'requestTransition')
    const { user } = renderMoves(operation, backend, { role: 'viewer' })
    await loaded()
    for (const name of ['Simulate', 'Stop preparing', 'Cancel']) {
      expect(move(name)).toHaveAttribute('aria-disabled', 'true')
      expect(move(name)).toHaveAccessibleDescription('Editors only')
    }
    await user.click(move('Simulate'))
    await user.click(move('Stop preparing'))
    expect(screen.queryByRole('group')).toBeNull()
    expect(asks).not.toHaveBeenCalled()
  })

  it('names the editor rule for a viewer who is a pilot, since it comes first', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'in_flight', [PILOT.userId])
    renderMoves(operation, backend, { role: 'viewer' })
    await loaded()
    expect(move('Stop')).toHaveAccessibleDescription('Editors only')
  })

  it('asks a plan with a client request id made fresh for each press', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    const asks = vi.spyOn(backend, 'requestTransition')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Plan'))
    await screen.findByText('Pending')
    await decide(backend, operation, 'running')
    await decide(backend, operation, 'accepted')
    await screen.findByText('Accepted')
    await user.click(move('Plan'))
    await waitFor(() => {
      expect(asks).toHaveBeenCalledTimes(2)
    })
    const [first, second] = asks.mock.calls.map(([, , id]) => id)
    expect(asks.mock.calls.map(([, transition]) => transition)).toEqual(['plan', 'plan'])
    expect(first).toMatch(UUID)
    expect(second).toMatch(UUID)
    expect(second).not.toBe(first)
  })

  it('confirms a simulation as a flight in the simulator, and asks it only once confirmed', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing', [PILOT.userId])
    const asks = vi.spyOn(backend, 'requestTransition')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Simulate'))
    const asking = screen.getByRole('group', { name: 'Fly in the simulator' })
    expect(asks).not.toHaveBeenCalled()
    await user.click(within(asking).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(asks).not.toHaveBeenCalled()
    await user.click(move('Simulate'))
    await user.click(
      within(screen.getByRole('group', { name: 'Fly in the simulator' })).getByRole('button', {
        name: 'Simulate',
      }),
    )
    await waitFor(() => {
      expect(asks).toHaveBeenCalledOnce()
    })
    expect(asks.mock.calls[0]?.[1]).toBe('simulate')
  })

  it('confirms a launch as a real flight before it is asked', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'ready', [PILOT.userId])
    const asks = vi.spyOn(backend, 'requestTransition')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Launch'))
    const asking = screen.getByRole('group', { name: 'Fly for real' })
    expect(within(asking).getByRole('button', { name: 'Launch' })).toBeEnabled()
    expect(within(asking).getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(asks).not.toHaveBeenCalled()
    await user.click(within(asking).getByRole('button', { name: 'Launch' }))
    await waitFor(() => {
      expect(asks).toHaveBeenCalledOnce()
    })
    expect(asks.mock.calls[0]?.[1]).toBe('launch')
  })

  it('confirms a stop as every aircraft returning home', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'in_flight', [PILOT.userId])
    const asks = vi.spyOn(backend, 'requestTransition')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Stop'))
    const asking = screen.getByRole('group', { name: 'Every aircraft returns home' })
    await user.click(within(asking).getByRole('button', { name: 'Stop' }))
    await waitFor(() => {
      expect(asks).toHaveBeenCalledOnce()
    })
    expect(asks.mock.calls[0]?.[1]).toBe('stop')
  })

  it('holds the moves while a request is pending or running, and frees them once it is accepted', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Plan'))
    expect(await screen.findByRole('status')).toHaveTextContent('PlanPending')
    expect(move('Plan')).toBeDisabled()
    expect(move('Cancel')).toBeDisabled()
    await decide(backend, operation, 'running')
    expect(await screen.findByRole('status')).toHaveTextContent('PlanRunning')
    expect(move('Plan')).toBeDisabled()
    await decide(backend, operation, 'accepted')
    expect(await screen.findByRole('status')).toHaveTextContent('PlanAccepted')
    await waitFor(() => {
      expect(move('Plan')).toBeEnabled()
    })
  })

  it('lists each reason of a refused request, in the alert style', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing', [PILOT.userId])
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Stop preparing'))
    await decide(backend, operation, 'running')
    await decide(backend, operation, 'refused', [
      'The geofence is not valid.',
      'No fleet flies the wayline.',
    ])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveClass('bg-danger-subtle')
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['The geofence is not valid.', 'No fleet flies the wayline.'])
    expect(screen.getByRole('status')).toHaveTextContent('Stop preparingRefused')
  })

  it('lists the reasons of a failed request too', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Plan'))
    await decide(backend, operation, 'running')
    await decide(backend, operation, 'failed', ['Sky Orchestrator did not answer.'])
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('listitem')).toHaveTextContent(
      'Sky Orchestrator did not answer.',
    )
    expect(screen.getByRole('status')).toHaveTextContent('PlanFailed')
  })

  it('shows the message of a move the database refuses, when the member asks for it', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.memberships.set(PILOT.userId, [{ ...NORTH, role: 'viewer' }])
    const { user } = renderMoves(operation, backend)
    await loaded()
    await user.click(move('Plan'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only editors and owners ask an operation to move.',
    )
    expect(move('Plan')).toBeEnabled()
  })

  it('says why the moves cannot be read, and reads them again on Try again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    vi.spyOn(backend, 'operators').mockRejectedValueOnce(new BackendError('Operators are down'))
    const { user } = renderMoves(operation, backend)
    expect(await screen.findByRole('alert')).toHaveTextContent('Operators are down')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Plan' })).toBeEnabled()
  })
})
