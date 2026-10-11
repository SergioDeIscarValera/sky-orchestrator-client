import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { FieldRefusedError, type FleetDraft, type Organization } from '../backend/backend'
import { BackendContext } from '../backend/context'
import { OrganizationContext } from '../organizations/context'
import { organizationKey } from '../organizations/scope'
import { FakeBackend, MAVIC_AIR_2, NORTH, ORCHARD, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import {
  useAircraftModels,
  useChangeFleet,
  useDevices,
  useFleets,
  useLiveState,
  useRegisterFleet,
  useRetireFleet,
} from './data'

/** A hook changes no DOM, so waitFor would only look again every 50 ms. */
const soon = (check: () => void) => waitFor(check, { interval: 1 })

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 3600,
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

function useFleetPanel() {
  return {
    fleets: useFleets(),
    devices: useDevices(),
    register: useRegisterFleet(),
    change: useChangeFleet(),
    retire: useRetireFleet(),
  }
}

describe("the open organization's fleets (FR-FLE-02, FR-FLE-03, FR-FLE-05)", () => {
  it('reads them under its key, so switching organization drops them', async () => {
    const { wrapper, queryClient } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useFleetPanel, { wrapper })
    await soon(() => {
      expect(result.current.devices.data).toHaveLength(1)
    })
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'devices'))).toHaveLength(1)
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'fleets'))).toEqual([])
  })

  it('reads the catalogue once a session', async () => {
    const backend = new FakeBackend(PILOT)
    const reads = vi.spyOn(backend, 'aircraftModels')
    const { wrapper } = opened(backend)
    const first = renderHook(useAircraftModels, { wrapper })
    await soon(() => {
      expect(first.result.current.data).toHaveLength(2)
    })
    const second = renderHook(useAircraftModels, { wrapper })
    expect(second.result.current.data).toHaveLength(2)
    expect(reads).toHaveBeenCalledOnce()
  })

  it('registers, changes and retires, each settled once the fleets were read again', async () => {
    const { wrapper, queryClient } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useFleetPanel, { wrapper })
    await soon(() => {
      expect(result.current.fleets.isSuccess).toBe(true)
    })
    const cached = () => queryClient.getQueryData(organizationKey(NORTH.id, 'fleets'))

    const fleet = await act(() => result.current.register.mutateAsync(DRAFT))
    expect(cached()).toEqual([fleet])
    await act(() =>
      result.current.change.mutateAsync({ id: fleet.id, changes: { name: 'Norte Alfa' } }),
    )
    expect(cached()).toEqual([{ ...fleet, name: 'Norte Alfa' }])
    await act(() => result.current.retire.mutateAsync(fleet.id))
    expect(cached()).toEqual([])
    await soon(() => {
      expect(result.current.fleets.data).toEqual([])
    })
  })

  it('passes on the field the database refused', async () => {
    const { wrapper } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useFleetPanel, { wrapper })
    const refused = await act(() =>
      result.current.register
        .mutateAsync({ ...DRAFT, airframeSerial: ' ' })
        .catch((e: unknown) => e),
    )
    expect(refused).toBeInstanceOf(FieldRefusedError)
    expect((refused as FieldRefusedError).field).toBe('airframeSerial')
  })

  it("refuses a viewer's write as the database would", async () => {
    const backend = new FakeBackend(PILOT)
    const theirs = await new FakeBackend(PILOT).registerFleet(NORTH.id, DRAFT)
    backend.registered.set(ORCHARD.id, [theirs])
    const { wrapper, queryClient } = opened(backend, ORCHARD)
    const { result } = renderHook(useFleetPanel, { wrapper })
    const attempts = [
      () => result.current.register.mutateAsync(DRAFT),
      () => result.current.change.mutateAsync({ id: theirs.id, changes: { name: 'Mine' } }),
      () => result.current.retire.mutateAsync(theirs.id),
    ]
    const refused: unknown[] = []
    for (const attempt of attempts) {
      refused.push(await act(() => attempt().catch((e: unknown) => e)))
    }
    expect(refused).toMatchObject([
      { code: '42501', field: null },
      { message: expect.stringMatching(/^Nothing changed/) as unknown },
      { message: expect.stringMatching(/^Nothing changed/) as unknown },
    ])
    await soon(() => {
      expect(queryClient.getQueryData(organizationKey(ORCHARD.id, 'fleets'))).toEqual([theirs])
    })
  })
})

describe("the organization's state topic (ADR-0007)", () => {
  it('reads again only what a change touched, and everything after a join', async () => {
    const backend = new FakeBackend(PILOT)
    const devices = vi.spyOn(backend, 'devices')
    const fleets = vi.spyOn(backend, 'fleets')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return useFleetPanel()
      },
      { wrapper },
    )
    await soon(() => {
      expect([devices.mock.calls.length, fleets.mock.calls.length]).toEqual([1, 1])
    })

    act(() => {
      backend.emit(NORTH.id, { kind: 'device', payload: { online: false } })
    })
    await soon(() => {
      expect(devices).toHaveBeenCalledTimes(2)
    })
    act(() => {
      backend.emit(NORTH.id, { kind: 'stack', payload: { link_state: 'unreachable' } })
    })
    await soon(() => {
      expect(devices).toHaveBeenCalledTimes(3)
    })
    expect(fleets).toHaveBeenCalledOnce()

    act(() => {
      backend.emit(NORTH.id, { kind: 'joined', payload: {} })
    })
    await soon(() => {
      expect([devices.mock.calls.length, fleets.mock.calls.length]).toEqual([4, 2])
    })
  })

  it('shows a fleet another console registered', async () => {
    const backend = new FakeBackend(PILOT)
    const { wrapper } = opened(backend)
    const { result } = renderHook(
      () => {
        useLiveState()
        return useFleets()
      },
      { wrapper },
    )
    await soon(() => {
      expect(result.current.data).toEqual([])
    })
    const elsewhere = new FakeBackend(PILOT)
    const fleet = await elsewhere.registerFleet(NORTH.id, DRAFT)
    backend.registered.set(NORTH.id, [fleet])
    act(() => {
      backend.emit(NORTH.id, { kind: 'fleet', payload: { id: fleet.id } })
    })
    await soon(() => {
      expect(result.current.data).toEqual([fleet])
    })
  })
})
