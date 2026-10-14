import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AccountContext } from '../account/account'
import { createConsoleRouter } from '../app/router'
import { Shell } from '../app/Shell'
import {
  BackendError,
  type Flight,
  type FlightState,
  type Operation,
  type OperationState,
} from '../backend/backend'
import { BackendContext } from '../backend/context'
import { SettingsContext } from '../config/settings'
import { OrganizationContext } from '../organizations/context'
import { OPERATIONS, organizationKey } from '../organizations/scope'
import { FakeBackend, NEIGHBOUR, NORTH, PILOT } from '../test/FakeBackend'
import { operationIn, renderInOrganization } from '../test/inOrganization'
import { quietQueryClient, SETTINGS } from '../test/render'
import { HOLD_MS } from './HoldButton'
import { SafetyBar } from './SafetyBar'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

/** The states the safety controls are shown in: an operation's aircraft launch or fly (FR-CMD-07). */
const AIRBORNE: readonly OperationState[] = ['launching', 'in_flight', 'paused', 'returning']

const FLIGHT_OWN = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000a1'
const FLIGHT_OWN_SECOND = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000a2'
const FLIGHT_ENDED = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000a3'
const FLIGHT_THEIRS = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000a4'

function flightOf(operation: Operation, id: string, endedAt: string | null = null): Flight {
  return {
    id,
    operationId: operation.id,
    mode: 'real',
    fleetId: '1f0c9d3e-7b1a-4c2e-8f5d-000000000001',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: '2026-10-11T10:00:00Z',
    executedAt: '2026-10-11T10:01:00Z',
    tookOffAt: null,
    landedAt: null,
    endedAt,
    endReason: null,
    breachedAt: null,
  }
}

function progressOf(flightId: string): FlightState {
  return {
    flightId,
    status: 'in_progress',
    result: null,
    percent: 42,
    currentWaypointIndex: 3,
    endReason: null,
    updatedAt: '2026-10-11T10:02:00Z',
  }
}

/** Lets the page's promises settle on the fake clock, so the mutations the test asked finish. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5)
  })
}

/** Holds a button for HOLD_MS on the fake clock, then lets it go, as a press does. */
async function hold(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOLD_MS)
  })
  fireEvent.pointerUp(button, { button: 0 })
  await settle()
}

/** The clock the holds run on: only the timers the holds and the query client's notices use are faked. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** Waits for the organization's operations to be read, so an absent control is absent for a reason. */
async function operationsRead(queryClient: ReturnType<typeof quietQueryClient>) {
  await waitFor(() => {
    expect(queryClient.getQueryState(organizationKey(NORTH.id, OPERATIONS))?.status).toBe('success')
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the safety controls, shown while an operation launches or flies (FR-CMD-07)', () => {
  it.each(STATES)(
    'is shown only while an operation is %s if it launches or flies',
    async (state) => {
      const backend = new FakeBackend(NEIGHBOUR)
      const operation = await operationIn(backend, state, [NEIGHBOUR.userId])
      backend.addFlight(flightOf(operation, FLIGHT_OWN))
      const { queryClient } = renderInOrganization(<SafetyBar />, {
        backend,
        account: NEIGHBOUR,
      })
      await operationsRead(queryClient)
      if (AIRBORNE.includes(state)) {
        const controls = await screen.findByRole('region', { name: 'Safety controls' })
        expect(within(controls).getByRole('button', { name: 'Pause all' })).toBeVisible()
        expect(within(controls).getByRole('button', { name: 'Return all home' })).toBeVisible()
      } else {
        expect(screen.queryByRole('region', { name: 'Safety controls' })).toBeNull()
      }
    },
  )
})

describe('the flights the safety controls send to (FR-CMD-01, FR-CMD-07)', () => {
  it('sends each hold to every flight not ended of the operations the member pilots, each with a request id of its own', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    const mineToo = await operationIn(backend, 'launching', [NEIGHBOUR.userId])
    const theirs = await operationIn(backend, 'paused', [PILOT.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    backend.addFlight(flightOf(mine, FLIGHT_ENDED, '2026-10-11T10:30:00Z'))
    backend.addFlight(flightOf(mineToo, FLIGHT_OWN_SECOND))
    backend.addFlight(flightOf(theirs, FLIGHT_THEIRS))
    backend.setFlightState(progressOf(FLIGHT_OWN))
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    expect(pauseAll).toHaveAttribute('aria-disabled', 'false')
    freezeClock()
    await hold(pauseAll)
    expect(ask).toHaveBeenCalledTimes(2)
    const sent = ask.mock.calls.map(([flightId, verb, clientRequestId]) => ({
      flightId,
      verb,
      clientRequestId,
    }))
    expect(sent.map(({ flightId }) => flightId).sort()).toEqual(
      [FLIGHT_OWN, FLIGHT_OWN_SECOND].sort(),
    )
    expect(sent.every(({ verb }) => verb === 'pause')).toBe(true)
    for (const { clientRequestId } of sent) expect(clientRequestId).toMatch(UUID)
    expect(sent[0]?.clientRequestId).not.toBe(sent[1]?.clientRequestId)
  })

  it('sends Return all home as return_home to the same flights, once per hold', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    backend.setFlightState(progressOf(FLIGHT_OWN))
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const returnAll = await screen.findByRole('button', { name: 'Return all home' })
    freezeClock()
    await hold(returnAll)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.slice(0, 2)).toEqual([FLIGHT_OWN, 'return_home'])
  })

  it('sends nothing on a click, nor on a press let go before the hold completes', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    freezeClock()
    fireEvent.pointerDown(pauseAll, { button: 0 })
    fireEvent.pointerUp(pauseAll, { button: 0 })
    fireEvent.click(pauseAll, { button: 0 })
    fireEvent.pointerDown(pauseAll, { button: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS - 100)
    })
    fireEvent.pointerUp(pauseAll, { button: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('is in the tab order, and is held from the keyboard with Space', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    const ask = vi.spyOn(backend, 'requestCommand')
    const { user } = renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    await user.tab()
    expect(pauseAll).toHaveFocus()
    freezeClock()
    fireEvent.keyDown(pauseAll, { key: ' ' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS)
    })
    fireEvent.keyUp(pauseAll, { key: ' ' })
    await settle()
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.slice(0, 2)).toEqual([FLIGHT_OWN, 'pause'])
  })
})

describe('who may hold the safety controls (FR-AUT-03, FR-CMD-01)', () => {
  it('says Pilots only to an editor who pilots none of the airborne operations, and sends nothing', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const theirs = await operationIn(backend, 'in_flight', [PILOT.userId])
    backend.addFlight(flightOf(theirs, FLIGHT_THEIRS))
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'editor' }])
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, {
      backend,
      account: NEIGHBOUR,
      organization: { ...NORTH, role: 'editor' },
    })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    expect(pauseAll).toHaveAttribute('aria-disabled', 'true')
    expect(pauseAll).toHaveAccessibleDescription('Pilots only')
    expect(screen.getByRole('button', { name: 'Return all home' })).toHaveAccessibleDescription(
      'Pilots only',
    )
    freezeClock()
    await hold(pauseAll)
    expect(ask).not.toHaveBeenCalled()
  })

  it('says Editors only to a viewer, even one who pilots an operation, and sends nothing', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, {
      backend,
      account: NEIGHBOUR,
      organization: { ...NORTH, role: 'viewer' },
    })
    const returnAll = await screen.findByRole('button', { name: 'Return all home' })
    expect(returnAll).toHaveAccessibleDescription('Editors only')
    freezeClock()
    await hold(returnAll)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('what the safety controls say when they cannot send (FR-CMD-07)', () => {
  it('shows a refusal of the database as its alert, and is held again once it is answered', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    vi.spyOn(backend, 'requestCommand').mockRejectedValueOnce(
      new BackendError('Sky Orchestrator is down'),
    )
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    freezeClock()
    await hold(pauseAll)
    expect(screen.getByRole('alert')).toHaveTextContent('Sky Orchestrator is down')
    expect(pauseAll).toHaveAttribute('aria-disabled', 'false')
  })

  it('holds nothing while the flights cannot be read, and says why', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const mine = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(mine, FLIGHT_OWN))
    vi.spyOn(backend, 'flights').mockRejectedValue(new BackendError('The flights are down'))
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const pauseAll = await screen.findByRole('button', { name: 'Pause all' })
    expect(await screen.findByRole('alert')).toHaveTextContent('The flights are down')
    expect(pauseAll).toHaveAccessibleDescription('The flights are down')
    freezeClock()
    await hold(pauseAll)
    expect(ask).not.toHaveBeenCalled()
  })

  it('stays shown, and holds nothing, when the operations themselves cannot be read', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    vi.spyOn(backend, 'operations').mockRejectedValue(new BackendError('The operations are down'))
    const ask = vi.spyOn(backend, 'requestCommand')
    renderInOrganization(<SafetyBar />, { backend, account: NEIGHBOUR })
    const controls = await screen.findByRole('region', { name: 'Safety controls' })
    expect(within(controls).getByRole('alert')).toHaveTextContent('The operations are down')
    freezeClock()
    await hold(within(controls).getByRole('button', { name: 'Return all home' }))
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('the safety controls while the rest of the console fails (FR-CMD-07)', () => {
  /**
   * The shell as the console mounts it, without the console's telemetry: a part that reads the
   * telemetry store throws, as a failing telemetry does. The operation is open in the inspector.
   */
  function renderShell(backend: FakeBackend, operationId: string) {
    window.history.replaceState(null, '', `/?panel=fleet&operation=${operationId}`)
    const choice = {
      organization: NORTH,
      organizations: [NORTH],
      choose: () => undefined,
    }
    const router = createConsoleRouter(Shell)
    const queryClient = quietQueryClient()
    return render(
      <SettingsContext value={SETTINGS}>
        <BackendContext value={backend}>
          <QueryClientProvider client={queryClient}>
            <AccountContext value={NEIGHBOUR}>
              <OrganizationContext value={choice}>
                <RouterProvider router={router} />
              </OrganizationContext>
            </AccountContext>
          </QueryClientProvider>
        </BackendContext>
      </SettingsContext>,
    )
  }

  it('sends pause all and return all home while telemetry, the log, the checks, the actions and the fleet panel fail', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await operationIn(backend, 'in_flight', [NEIGHBOUR.userId])
    backend.addFlight(flightOf(operation, FLIGHT_OWN))
    backend.setFlightState(progressOf(FLIGHT_OWN))
    for (const read of ['events', 'checks', 'requests', 'devices'] as const) {
      vi.spyOn(backend, read).mockRejectedValue(new BackendError(`${read} is down`))
    }
    // The console's own failure is logged by React as it is caught: the test expects it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ask = vi.spyOn(backend, 'requestCommand')
    renderShell(backend, operation.id)

    const controls = await screen.findByRole('region', { name: 'Safety controls' })
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(await within(inspector).findByText(/The inspector stopped/)).toBeVisible()
    expect(within(controls).getByRole('button', { name: 'Pause all' })).toHaveAttribute(
      'aria-disabled',
      'false',
    )

    freezeClock()
    await hold(within(controls).getByRole('button', { name: 'Pause all' }))
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.slice(0, 2)).toEqual([FLIGHT_OWN, 'pause'])

    await hold(within(controls).getByRole('button', { name: 'Return all home' }))
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]?.slice(0, 2)).toEqual([FLIGHT_OWN, 'return_home'])
  })
})
