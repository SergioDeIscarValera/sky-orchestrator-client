import { waitFor } from '@testing-library/react'

import { GEOFENCES, OPERATIONS, organizationKey } from '../organizations/scope'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { createTelemetryStore } from '../telemetry/store'
import { useCameraCommands, type SceneBox } from './commands'
import { OperationFocus } from './OperationFocus'
import { FARM, at, farmWithOperation, live, mountScene } from './sceneTestKit'
import { FLAT_SITE } from './site'

beforeEach(() => {
  // As a mounted camera leaves it (Controls): these tests frame without one, so they say it is there.
  useCameraCommands.setState({ last: null, pinned: null, ready: true })
})

/** The box the last fit command carries, or a failure when the camera was not sent one. */
function fitted(): SceneBox {
  const last = useCameraCommands.getState().last
  if (last?.command !== 'fit' || last.box === undefined) throw new Error('no fit was sent')
  return last.box
}

const sequence = () => useCameraCommands.getState().last?.sequence ?? 0

describe('the selected operation framed as a whole (FR-SCN-05)', () => {
  it('frames its geofence, its planned flight and its aircraft once its data has loaded', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const store = createTelemetryStore()
    // The aircraft flies 300 m east of the farm, past the geofence's edge at 200 m.
    store.getState().receive(live(10, 300, 20), performance.now())
    const mounted = await mountScene({ backend, store })
    mounted.render(<OperationFocus operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    await waitFor(() => {
      expect(useCameraCommands.getState().last?.command).toBe('fit')
    })
    // The geofence's edges sit 200 m out, the aircraft at 300 m; the projection rounds by under a micrometre.
    const box = fitted()
    expect(box.min.x).toBeLessThanOrEqual(-199.9)
    expect(box.max.x).toBeGreaterThanOrEqual(299.9)
    expect(box.min.z).toBeLessThanOrEqual(-199.9)
    expect(box.max.z).toBeGreaterThanOrEqual(199.9)
    // The flight climbs from the takeoff at the farm, so the box reaches down to the ground there.
    expect(box.min.y).toBeLessThanOrEqual(0.001)
    expect(box.max.y).toBeGreaterThanOrEqual(29.9)
    mounted.unmount()
  })

  it('holds the fit until the camera is ready to take it, then sends it once', async () => {
    useCameraCommands.setState({ ready: false })
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const queryClient = quietQueryClient()
    const reads = vi.spyOn(backend, 'geofences')
    const mounted = await mountScene({ backend, store: createTelemetryStore(), queryClient })
    mounted.render(<OperationFocus operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    await waitFor(() => {
      expect(reads).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0)
    })
    // The data is read; a command sent now would be lost, so none is.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useCameraCommands.getState().last).toBeNull()

    useCameraCommands.setState({ ready: true })
    await waitFor(() => {
      expect(sequence()).toBe(1)
    })
    mounted.unmount()
  })

  it('sends the fit once per selection, and not again when the operation is read again', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation, geofence } = await farmWithOperation(backend)
    const queryClient = quietQueryClient()
    const mounted = await mountScene({
      backend,
      store: createTelemetryStore(),
      queryClient,
    })
    mounted.render(<OperationFocus operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    await waitFor(() => {
      expect(sequence()).toBe(1)
    })

    // The operation and its geofence are read again, and each comes back changed: the view is not refit.
    const reads = vi.spyOn(backend, 'geofences')
    await backend.changeOperation(operation.id, { name: 'North corridor, renamed' })
    await backend.changeGeofence(geofence.id, { name: 'North fence, renamed' })
    await queryClient.invalidateQueries({ queryKey: organizationKey(NORTH.id, OPERATIONS) })
    await queryClient.invalidateQueries({ queryKey: organizationKey(NORTH.id, GEOFENCES) })
    await waitFor(() => {
      expect(reads).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0)
    })
    expect(sequence()).toBe(1)
    mounted.unmount()
  })

  it('frames another operation when it is selected, and this one again when it is selected again', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const far = await backend.createGeofence(NORTH.id, {
      name: 'South fence',
      polygon: [at(500, 500), at(900, 500), at(900, 900), at(500, 900)],
      maxHeightM: 120,
      origin: 'drawn',
      marginM: null,
    })
    const other = await backend.createOperation(NORTH.id, {
      name: 'South corridor',
      geofenceId: far.id,
      takeoffSecurityHeightM: null,
    })
    const mounted = await mountScene({ backend, store: createTelemetryStore() })
    const select = (id: string) => {
      mounted.render(<OperationFocus operationId={id} site={FLAT_SITE} origin={FARM} />)
    }

    select(operation.id)
    await waitFor(() => {
      expect(sequence()).toBe(1)
    })
    select(other.id)
    await waitFor(() => {
      expect(sequence()).toBe(2)
    })
    expect(fitted().max.x).toBeGreaterThanOrEqual(900)

    select(operation.id)
    await waitFor(() => {
      expect(sequence()).toBe(3)
    })
    expect(fitted().max.x).toBeLessThan(900)
    mounted.unmount()
  })

  it('frames nothing with no operation selected, nor one the backend does not hold', async () => {
    const backend = new FakeBackend(PILOT)
    await farmWithOperation(backend)
    const queryClient = quietQueryClient()
    const reads = vi.spyOn(backend, 'operations')
    const mounted = await mountScene({
      backend,
      store: createTelemetryStore(),
      queryClient,
    })
    mounted.render(<OperationFocus operationId={null} site={FLAT_SITE} origin={FARM} />)
    mounted.render(
      <OperationFocus
        operationId="00000000-0000-4000-b000-999999999999"
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
    expect(useCameraCommands.getState().last).toBeNull()
    mounted.unmount()
  })
})
