import { waitFor } from '@testing-library/react'

import type { Selection } from '../app/router'
import type { OperationState } from '../backend/backend'
import { FakeBackend, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { createTelemetryStore } from '../telemetry/store'
import { FleetOperation } from './FleetOperation'
import { FARM, farmWithOperation, flightOf, live, mountScene, stored } from './sceneTestKit'
import { FLAT_SITE } from './site'

const TO_IN_FLIGHT: readonly OperationState[] = [
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
]

/** An operation with its fleet's flight in the air, its stored track and two live samples, moved along `path`. */
async function flyingOn(backend: FakeBackend, path: readonly OperationState[]) {
  const { fleet, operation } = await farmWithOperation(backend)
  for (const state of path) backend.moveOperation(operation.id, state)
  const flight = flightOf(operation.id, fleet.id)
  backend.addFlight(flight)
  backend.addTrackPoints(flight.id, [stored(0, 0, 0), stored(1, 10, 10), stored(2, 20, 20)])
  return { fleet, operation }
}

describe("a selected aircraft's flight in an underway operation (FR-SCN-04)", () => {
  it("draws its operation's planned flight and its track while the fleet is in flight", async () => {
    const backend = new FakeBackend(PILOT)
    const { fleet } = await flyingOn(backend, TO_IN_FLIGHT)
    const store = createTelemetryStore()
    store.getState().receive(live(3, 30, 30), performance.now())
    store.getState().receive(live(4, 40, 40), performance.now())
    const mounted = await mountScene({ backend, store })
    mounted.render(
      <FleetOperation
        selection={{ kind: 'fleet', fleetId: fleet.id }}
        site={FLAT_SITE}
        origin={FARM}
      />,
    )
    await waitFor(() => {
      expect(mounted.scene().getObjectByName('planned flight')).toBeDefined()
      expect(mounted.scene().getObjectByName('flight track')).toBeDefined()
    })
    mounted.unmount()
  })

  it('draws the same for the aircraft the fleet flies, selected as the aircraft', async () => {
    const backend = new FakeBackend(PILOT)
    await flyingOn(backend, TO_IN_FLIGHT)
    const mounted = await mountScene({ backend, store: createTelemetryStore() })
    mounted.render(
      <FleetOperation
        selection={{ kind: 'device', gatewaySn: 'SOTESTDOCK01', aircraftSn: 'SOTESTUAV001' }}
        site={FLAT_SITE}
        origin={FARM}
      />,
    )
    await waitFor(() => {
      expect(mounted.scene().getObjectByName('planned flight')).toBeDefined()
    })
    mounted.unmount()
  })

  it.each([
    ['a draft', []],
    ['planned', ['planned'] as const],
    ['completed', [...TO_IN_FLIGHT, 'returning', 'completed'] as const],
  ])('draws nothing for a fleet in an operation that is %s', async (_, path) => {
    const backend = new FakeBackend(PILOT)
    const { fleet } = await flyingOn(backend, path)
    const queryClient = quietQueryClient()
    const reads = vi.spyOn(backend, 'operations')
    const mounted = await mountScene({ backend, store: createTelemetryStore(), queryClient })
    mounted.render(
      <FleetOperation
        selection={{ kind: 'fleet', fleetId: fleet.id }}
        site={FLAT_SITE}
        origin={FARM}
      />,
    )
    await waitFor(() => {
      expect(reads).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0)
    })
    expect(mounted.scene().getObjectByName('planned flight')).toBeUndefined()
    expect(mounted.scene().getObjectByName('flight track')).toBeUndefined()
    mounted.unmount()
  })

  it.each<[string, Selection]>([
    ['a geofence', { kind: 'geofence', geofenceId: '00000000-0000-4000-8000-000000000001' }],
    [
      'an aircraft no fleet registers',
      { kind: 'device', gatewaySn: 'SOTESTDOCK01', aircraftSn: 'SOTESTUAV009' },
    ],
  ])('draws nothing for %s', async (_, selection) => {
    const backend = new FakeBackend(PILOT)
    await flyingOn(backend, TO_IN_FLIGHT)
    const mounted = await mountScene({ backend, store: createTelemetryStore() })
    mounted.render(<FleetOperation selection={selection} site={FLAT_SITE} origin={FARM} />)
    expect(mounted.scene().getObjectByName('planned flight')).toBeUndefined()
    expect(mounted.scene().getObjectByName('flight track')).toBeUndefined()
    mounted.unmount()
  })
})
