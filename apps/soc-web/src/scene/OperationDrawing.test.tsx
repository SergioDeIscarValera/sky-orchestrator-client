import { act, waitFor } from '@testing-library/react'
import type { Line2 } from 'three/addons/lines/Line2.js'

import { FakeBackend, PILOT } from '../test/FakeBackend'
import { createTelemetryStore } from '../telemetry/store'
import { OperationDrawing } from './OperationDrawing'
import { FLAT_SITE } from './site'
import {
  DESIGN,
  FARM,
  farmWithOperation,
  flightOf,
  live,
  mountScene,
  stored,
  verticesOf,
} from './sceneTestKit'
import { trackSpots, type Vertex } from './track'

describe('the selected operation in the scene (FR-SCN-04, FR-OPS-07)', () => {
  it('draws the geofence and the planned flight of a selected operation, and nothing for none', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const mounted = await mountScene({ backend, store: createTelemetryStore() })
    mounted.render(<OperationDrawing operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    await waitFor(() => {
      expect(mounted.scene().getObjectByName('geofence North fence')).toBeDefined()
      expect(mounted.scene().getObjectByName('planned flight')).toBeDefined()
    })
    mounted.render(<OperationDrawing operationId={null} site={FLAT_SITE} origin={FARM} />)
    expect(mounted.scene().getObjectByName('geofence North fence')).toBeUndefined()
    expect(mounted.scene().getObjectByName('planned flight')).toBeUndefined()
    expect(mounted.scene().getObjectByName('flight track')).toBeUndefined()
    mounted.unmount()
  })

  it("draws a flight's track: its stored samples in time order, then the live ones after the last", async () => {
    const backend = new FakeBackend(PILOT)
    const { fleet, operation } = await farmWithOperation(backend)
    const flight = flightOf(operation.id, fleet.id)
    backend.addFlight(flight)
    const points = [stored(0, 0, 0), stored(1, 10, 10), stored(2, 20, 20)]
    backend.addTrackPoints(flight.id, points)
    const store = createTelemetryStore()
    // The store keeps the latest two samples of the aircraft: the stored track ends at the second.
    store.getState().receive(live(2, 20, 20), 0)
    store.getState().receive(live(3, 30, 30), 1000)
    store.getState().receive(live(4, 40, 40), 2000)
    const mounted = await mountScene({ backend, store })
    mounted.render(<OperationDrawing operationId={operation.id} site={FLAT_SITE} origin={FARM} />)

    const expected: Vertex[] = trackSpots(
      { origin: FARM, ground: FLAT_SITE.ground, takeoff: DESIGN.takeoff },
      points,
      [live(3, 30, 30), live(4, 40, 40)],
    )
    await waitFor(() => {
      const track = mounted.scene().getObjectByName('flight track') as Line2 | undefined
      expect(track).toBeDefined()
      const vertices = track === undefined ? [] : verticesOf(track)
      expect(vertices).toHaveLength(expected.length)
      for (const [index, spot] of expected.entries()) {
        for (const [axis, value] of spot.entries()) {
          expect(vertices[index]?.[axis]).toBeCloseTo(value, 4)
        }
      }
    })
    mounted.unmount()
  })

  it('rebuilds the track as a live sample arrives, disposes what it replaces, and frees the last at unmount', async () => {
    const backend = new FakeBackend(PILOT)
    const { fleet, operation } = await farmWithOperation(backend)
    const flight = flightOf(operation.id, fleet.id)
    backend.addFlight(flight)
    backend.addTrackPoints(flight.id, [stored(0, 0, 0), stored(1, 10, 10), stored(2, 20, 20)])
    const store = createTelemetryStore()
    store.getState().receive(live(3, 30, 30), 0)
    store.getState().receive(live(4, 40, 40), 1000)
    const mounted = await mountScene({ backend, store })
    mounted.render(<OperationDrawing operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    const track = (): Line2 => {
      const found = mounted.scene().getObjectByName('flight track') as Line2 | undefined
      if (found === undefined) throw new Error('no track in the scene')
      return found
    }
    await waitFor(() => {
      expect(verticesOf(track())).toHaveLength(5)
    })

    const before = track().geometry
    const disposed = vi.spyOn(before, 'dispose')
    act(() => {
      store.getState().receive(live(5, 50, 50), 2000)
    })
    await waitFor(() => {
      expect(track().geometry).not.toBe(before)
    })
    expect(disposed).toHaveBeenCalledOnce()
    expect(verticesOf(track()).at(-1)?.[0]).toBeCloseTo(50, 3)

    const last = track().geometry
    const lastDisposed = vi.spyOn(last, 'dispose')
    const material = vi.spyOn(track().material, 'dispose')
    mounted.unmount()
    expect(lastDisposed).toHaveBeenCalledOnce()
    expect(material).toHaveBeenCalledOnce()
  })
})
