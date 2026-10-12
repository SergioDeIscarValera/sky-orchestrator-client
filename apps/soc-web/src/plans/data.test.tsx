import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import {
  FieldRefusedError,
  type GeofenceDraft,
  type Organization,
  type WaylineDraft,
} from '../backend/backend'
import { BackendContext } from '../backend/context'
import { useFleets, useLiveState } from '../fleets/data'
import { OrganizationContext } from '../organizations/context'
import { organizationKey } from '../organizations/scope'
import { FakeBackend, NORTH, ORCHARD, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import {
  useChangeGeofence,
  useChangeWayline,
  useCreateGeofence,
  useCreateWayline,
  useGeofences,
  useRetireGeofence,
  useRetireWayline,
  useWaylines,
} from './data'

/** A hook changes no DOM, so waitFor would only look again every 50 ms. */
const soon = (check: () => void) => waitFor(check, { interval: 1 })

const GEOFENCE: GeofenceDraft = {
  name: 'Norte',
  polygon: [
    { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
    { latitudeDeg: 41.6523, longitudeDeg: -4.71 },
    { latitudeDeg: 41.64, longitudeDeg: -4.71 },
  ],
  maxHeightM: 120,
  origin: 'drawn',
  marginM: null,
}

const WAYLINE: WaylineDraft = {
  name: 'Ronda',
  takeoff: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
  defaultHeightM: 40,
  design: { schema_version: '1.0.0', primitives: [] },
  waypoints: [{ index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 40 }],
  metrics: { waypointCount: 1, distanceM: 0 },
  bakeVersion: '1.0.0',
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

function useGeofencePanel() {
  return {
    geofences: useGeofences(),
    create: useCreateGeofence(),
    change: useChangeGeofence(),
    retire: useRetireGeofence(),
  }
}

function useWaylinePanel() {
  return {
    waylines: useWaylines(),
    create: useCreateWayline(),
    change: useChangeWayline(),
    retire: useRetireWayline(),
  }
}

describe("the open organization's geofences and waylines (IR-GEO, IR-WAY)", () => {
  it('reads them under its key, so switching organization drops them', async () => {
    const backend = new FakeBackend(PILOT)
    const made = await new FakeBackend(PILOT).createGeofence(NORTH.id, GEOFENCE)
    backend.geofenceRows.set(NORTH.id, [made])
    const { wrapper, queryClient } = opened(backend)
    const { result } = renderHook(useGeofencePanel, { wrapper })
    await soon(() => {
      expect(result.current.geofences.data).toEqual([made])
    })
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'geofences'))).toEqual([made])
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'waylines'))).toBeUndefined()
    expect(queryClient.getQueryData(['geofences'])).toBeUndefined()
  })

  it('creates, changes and retires a geofence, each settled once the list was read again', async () => {
    const { wrapper, queryClient } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useGeofencePanel, { wrapper })
    await soon(() => {
      expect(result.current.geofences.isSuccess).toBe(true)
    })
    const cached = () => queryClient.getQueryData(organizationKey(NORTH.id, 'geofences'))

    const geofence = await act(() => result.current.create.mutateAsync(GEOFENCE))
    expect(cached()).toEqual([geofence])
    const renamed = await act(() =>
      result.current.change.mutateAsync({ id: geofence.id, changes: { name: 'Norte Alfa' } }),
    )
    expect(renamed.name).toBe('Norte Alfa')
    expect(cached()).toEqual([renamed])
    await act(() => result.current.retire.mutateAsync(geofence.id))
    expect(cached()).toEqual([])
    await soon(() => {
      expect(result.current.geofences.data).toEqual([])
    })
  })

  it('creates, changes and retires a wayline, each settled once the list was read again', async () => {
    const { wrapper, queryClient } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useWaylinePanel, { wrapper })
    await soon(() => {
      expect(result.current.waylines.isSuccess).toBe(true)
    })
    const cached = () => queryClient.getQueryData(organizationKey(NORTH.id, 'waylines'))

    const wayline = await act(() => result.current.create.mutateAsync(WAYLINE))
    expect(cached()).toEqual([wayline])
    const renamed = await act(() =>
      result.current.change.mutateAsync({ id: wayline.id, changes: { name: 'Ronda alta' } }),
    )
    expect(renamed.name).toBe('Ronda alta')
    expect(cached()).toEqual([renamed])
    await act(() => result.current.retire.mutateAsync(wayline.id))
    expect(cached()).toEqual([])
    await soon(() => {
      expect(result.current.waylines.data).toEqual([])
    })
  })

  it('passes on the field the database refused', async () => {
    const { wrapper } = opened(new FakeBackend(PILOT))
    const { result } = renderHook(useGeofencePanel, { wrapper })
    const refused = await act(() =>
      result.current.create.mutateAsync({ ...GEOFENCE, name: ' ' }).catch((e: unknown) => e),
    )
    expect(refused).toBeInstanceOf(FieldRefusedError)
    expect((refused as FieldRefusedError).field).toBe('name')
  })

  it("refuses a viewer's write as the database would", async () => {
    const backend = new FakeBackend(PILOT)
    // Made where PILOT owns, then placed in the organization where PILOT only reads.
    const theirs = await new FakeBackend(PILOT).createGeofence(NORTH.id, GEOFENCE)
    backend.geofenceRows.set(ORCHARD.id, [theirs])
    const { wrapper, queryClient } = opened(backend, ORCHARD)
    const { result } = renderHook(useGeofencePanel, { wrapper })
    const attempts = [
      () => result.current.create.mutateAsync(GEOFENCE),
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
      expect(queryClient.getQueryData(organizationKey(ORCHARD.id, 'geofences'))).toEqual([theirs])
    })
  })
})

describe("the organization's state topic keeps the geofences and waylines current", () => {
  it('a geofence change reads the geofences again, and neither the fleets nor the waylines', async () => {
    const backend = new FakeBackend(PILOT)
    const geofences = vi.spyOn(backend, 'geofences')
    const waylines = vi.spyOn(backend, 'waylines')
    const fleets = vi.spyOn(backend, 'fleets')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return { ...useGeofencePanel(), ...useWaylinePanel(), fleets: useFleets() }
      },
      { wrapper },
    )
    await soon(() => {
      expect([
        geofences.mock.calls.length,
        waylines.mock.calls.length,
        fleets.mock.calls.length,
      ]).toEqual([1, 1, 1])
    })

    act(() => {
      backend.emit(NORTH.id, { kind: 'geofence', payload: { id: 'x', name: 'Norte' } })
    })
    await soon(() => {
      expect(geofences).toHaveBeenCalledTimes(2)
    })
    expect([waylines, fleets].map((spy) => spy.mock.calls.length)).toEqual([1, 1])
  })

  it('a wayline change reads the waylines again, and neither the geofences nor the fleets', async () => {
    const backend = new FakeBackend(PILOT)
    const geofences = vi.spyOn(backend, 'geofences')
    const waylines = vi.spyOn(backend, 'waylines')
    const fleets = vi.spyOn(backend, 'fleets')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return { ...useGeofencePanel(), ...useWaylinePanel(), fleets: useFleets() }
      },
      { wrapper },
    )
    await soon(() => {
      expect(waylines).toHaveBeenCalledOnce()
    })

    act(() => {
      backend.emit(NORTH.id, { kind: 'wayline', payload: { id: 'y', name: 'Ronda' } })
    })
    await soon(() => {
      expect(waylines).toHaveBeenCalledTimes(2)
    })
    expect([geofences, fleets].map((spy) => spy.mock.calls.length)).toEqual([1, 1])
  })

  it('a join reads everything again, the geofences and the waylines included', async () => {
    const backend = new FakeBackend(PILOT)
    const geofences = vi.spyOn(backend, 'geofences')
    const waylines = vi.spyOn(backend, 'waylines')
    const { wrapper } = opened(backend)
    renderHook(
      () => {
        useLiveState()
        return { ...useGeofencePanel(), ...useWaylinePanel() }
      },
      { wrapper },
    )
    await soon(() => {
      expect([geofences.mock.calls.length, waylines.mock.calls.length]).toEqual([1, 1])
    })
    act(() => {
      backend.emit(NORTH.id, { kind: 'joined', payload: {} })
    })
    await soon(() => {
      expect([geofences.mock.calls.length, waylines.mock.calls.length]).toEqual([2, 2])
    })
  })

  it('shows a geofence another console drew', async () => {
    const backend = new FakeBackend(PILOT)
    const { wrapper } = opened(backend)
    const { result } = renderHook(
      () => {
        useLiveState()
        return useGeofences()
      },
      { wrapper },
    )
    await soon(() => {
      expect(result.current.data).toEqual([])
    })
    const elsewhere = await new FakeBackend(PILOT).createGeofence(NORTH.id, GEOFENCE)
    backend.geofenceRows.set(NORTH.id, [elsewhere])
    act(() => {
      backend.emit(NORTH.id, {
        kind: 'geofence',
        payload: {
          id: elsewhere.id,
          name: elsewhere.name,
          origin: 'drawn',
          updated_at: elsewhere.updatedAt,
          deleted_at: null,
        },
      })
    })
    await soon(() => {
      expect(result.current.data).toEqual([elsewhere])
    })
  })
})
