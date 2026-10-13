import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import {
  FieldRefusedError,
  type OperationCheck,
  type OperationDraft,
  type Organization,
} from '../backend/backend'
import { BackendContext } from '../backend/context'
import { useLiveState } from '../fleets/data'
import { OrganizationContext } from '../organizations/context'
import { organizationKey } from '../organizations/scope'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import {
  useChecks,
  useChangeOperation,
  useCreateOperation,
  useEvents,
  useFlightStates,
  useOperation,
  useFlights,
  useOperations,
  useStacks,
} from './data'

/** A hook changes no DOM, so waitFor would only look again every 50 ms. */
const soon = (check: () => void) => waitFor(check, { interval: 1 })

const DRAFT: OperationDraft = {
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
}

const CHECK: OperationCheck = {
  checkId: 'PF-GNSS',
  state: 'pass',
  blocking: true,
  value: { satellites: 14 },
  detail: null,
  evaluatedAt: '2026-10-11T10:10:00Z',
}

function opened(
  backend: FakeBackend,
  organization: Organization = NORTH,
  queryClient: QueryClient = quietQueryClient(),
) {
  const choice = { organization, organizations: [organization], choose: () => undefined }
  return {
    queryClient,
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <BackendContext value={backend}>
        <QueryClientProvider client={queryClient}>
          <OrganizationContext value={choice}>{children}</OrganizationContext>
        </QueryClientProvider>
      </BackendContext>
    ),
  }
}

describe("the open organization's operations (IR-OPS, IR-OPR, FR-OPS-01)", () => {
  it("reads them under the organization's key, and one of them by its id", async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    const { wrapper, queryClient } = opened(backend)
    const { result } = renderHook(
      () => ({ all: useOperations(), one: useOperation(operation.id) }),
      { wrapper },
    )
    await soon(() => {
      expect(result.current.one.data).toEqual(operation)
    })
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'operations'))).toEqual([operation])
  })

  it('creates an operation and reads the operations again, so it is on screen', async () => {
    const backend = new FakeBackend(PILOT)
    const { wrapper, queryClient } = opened(backend)
    const { result } = renderHook(() => ({ list: useOperations(), create: useCreateOperation() }), {
      wrapper,
    })
    await soon(() => {
      expect(result.current.list.isSuccess).toBe(true)
    })
    const made = await act(() => result.current.create.mutateAsync(DRAFT))
    expect(made.state).toBe('draft')
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'operations'))).toEqual([made])
  })

  it('passes on the refusal the database made, as the mutation fails', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    backend.moveOperation(operation.id, 'cancelled')
    const { wrapper } = opened(backend)
    const { result } = renderHook(() => useChangeOperation(), { wrapper })
    const refused = await act(() =>
      result.current
        .mutateAsync({ id: operation.id, changes: { name: 'Norte' } })
        .catch((error: unknown) => error),
    )
    expect(refused).toBeInstanceOf(FieldRefusedError)
    expect(refused).toMatchObject({
      field: null,
      message: 'This operation has ended, and does not change.',
    })
  })
})

describe("the operation's log and checks, kept current from the state topic (FR-LOG-03, FR-OPS-04)", () => {
  it('replaces a check in the cache when its judgement changes, without reading it again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    backend.addCheck(operation.id, CHECK)
    const reads = vi.spyOn(backend, 'checks')
    const { wrapper } = opened(backend)
    const { result } = renderHook(
      () => {
        useLiveState()
        return useChecks(operation.id)
      },
      { wrapper },
    )
    await soon(() => {
      expect(result.current.data).toEqual([CHECK])
    })
    act(() => {
      backend.addCheck(operation.id, { ...CHECK, state: 'fail', detail: 'Nine satellites.' })
    })
    await soon(() => {
      expect(result.current.data).toEqual([{ ...CHECK, state: 'fail', detail: 'Nine satellites.' }])
    })
    expect(reads).toHaveBeenCalledOnce()
  })

  it('appends each log entry to the log in the cache, without reading the log again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    const reads = vi.spyOn(backend, 'events')
    const { wrapper } = opened(backend)
    const { result } = renderHook(
      () => {
        useLiveState()
        return useEvents(operation.id)
      },
      { wrapper },
    )
    await soon(() => {
      expect(result.current.data).toHaveLength(1)
    })
    act(() => {
      backend.addEvent(
        operation.id,
        'transition_refused',
        'soc-operations',
        { transition: 'plan' },
        'warning',
      )
    })
    await soon(() => {
      expect(result.current.data).toMatchObject([
        { kind: 'operation_created' },
        { kind: 'transition_refused', severity: 'warning', source: 'soc-operations' },
      ])
    })
    expect(reads).toHaveBeenCalledOnce()
  })

  it('reads the flight states again when a flight state changes', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    const reads = vi.spyOn(backend, 'flightStates')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return useFlightStates(operation.id)
      },
      { wrapper },
    )
    await soon(() => {
      expect(reads).toHaveBeenCalledOnce()
    })
    act(() => {
      backend.emit(NORTH.id, {
        kind: 'flight_state',
        payload: { flight_id: '88888888-8888-4888-8888-888888888888', status: 'ok' },
      })
    })
    await soon(() => {
      expect(reads).toHaveBeenCalledTimes(2)
    })
  })

  it('reads a log entry or a check it cannot read again, rather than writing a guess into the cache', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    backend.addCheck(operation.id, CHECK)
    const events = vi.spyOn(backend, 'events')
    const checks = vi.spyOn(backend, 'checks')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return { log: useEvents(operation.id), checks: useChecks(operation.id) }
      },
      { wrapper },
    )
    await soon(() => {
      expect([events.mock.calls.length, checks.mock.calls.length]).toEqual([1, 1])
    })
    act(() => {
      backend.emit(NORTH.id, { kind: 'operation_event', payload: { id: 'not-a-row' } })
      backend.emit(NORTH.id, { kind: 'operation_check', payload: { check_id: 'GNSS' } })
    })
    await soon(() => {
      expect([events.mock.calls.length, checks.mock.calls.length]).toEqual([2, 2])
    })
  })

  it('reads the flights again when one changes, its breach time and a key it does not read included', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    const reads = vi.spyOn(backend, 'flights')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return useFlights(operation.id)
      },
      { wrapper },
    )
    await soon(() => {
      expect(reads).toHaveBeenCalledOnce()
    })
    act(() => {
      backend.emit(NORTH.id, {
        kind: 'flight',
        payload: {
          id: '88888888-8888-4888-8888-888888888888',
          operation_id: operation.id,
          breached_at: '2026-10-11T10:30:00+00:00',
          column_added_later: true,
        },
      })
    })
    await soon(() => {
      expect(reads).toHaveBeenCalledTimes(2)
    })
  })

  it('reads the stacks again when a stack changes, its envelope included', async () => {
    const backend = new FakeBackend(PILOT)
    const reads = vi.spyOn(backend, 'stacks')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return useStacks()
      },
      { wrapper },
    )
    await soon(() => {
      expect(reads).toHaveBeenCalledOnce()
    })
    act(() => {
      backend.emit(NORTH.id, { kind: 'stack', payload: { gateway_sn: 'SOTESTDOCK01' } })
    })
    await soon(() => {
      expect(reads).toHaveBeenCalledTimes(2)
    })
  })
})
