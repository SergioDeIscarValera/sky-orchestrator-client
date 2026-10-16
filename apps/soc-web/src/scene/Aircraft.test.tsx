import { RouterProvider } from '@tanstack/react-router'
import { waitFor } from '@testing-library/react'
import type { InstancedMesh } from 'three'
import { Matrix4 } from 'three'

import { createConsoleRouter } from '../app/router'
import { FakeBackend, MAVIC_AIR_2, NORTH, PILOT } from '../test/FakeBackend'
import { createTelemetryStore } from '../telemetry/store'
import { Aircraft } from './Aircraft'
import { FARM, farmWithOperation, live, mountScene, type MountedScene } from './sceneTestKit'
import { FLAT_SITE } from './site'

/** The east position of each aircraft the bodies draw, in the order the scene drew them. */
function drawnEast(scene: MountedScene): number[] {
  const bodies = scene.scene().getObjectByName('aircraft') as InstancedMesh | undefined
  if (bodies === undefined) throw new Error('no aircraft in the scene')
  const matrix = new Matrix4()
  return Array.from({ length: bodies.count }, (_, index) => {
    bodies.getMatrixAt(index, matrix)
    // The fourth column of a transform is its translation: the east position is its x.
    return matrix.elements[12]
  })
}

/** The console's aircraft, under a router whose view is the URL it is opened on (NFR-UX-03). */
function aircraftAt(url: string) {
  window.history.replaceState(null, '', url)
  return createConsoleRouter(() => <Aircraft origin={FARM} site={FLAT_SITE} />)
}

describe('the aircraft drawn while an operation is selected (FR-SCN-04)', () => {
  it("draws only the operation's fleets' aircraft while it is selected, and every aircraft with none", async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    await backend.registerFleet(NORTH.id, {
      name: 'Sur 2',
      model: MAVIC_AIR_2.model,
      airframeSerial: '2SURF',
      controllerSerial: null,
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV002',
      flightTimeBeforeSocS: 5400,
    })
    // Norte 1 is 0 m east of the farm, the aircraft of no operation 50 m east of it.
    const store = createTelemetryStore()
    const received = performance.now()
    store.getState().receive(live(10, 0, 20), received)
    store.getState().receive({ ...live(10, 50, 20), aircraftSn: 'SOTESTUAV002' }, received)

    const selected = await mountScene({ backend, store })
    selected.render(<RouterProvider router={aircraftAt(`/?operation=${operation.id}`)} />)
    await waitFor(() => {
      selected.advance()
      expect(drawnEast(selected)).toHaveLength(1)
    })
    expect(drawnEast(selected)[0]).toBeCloseTo(0, 3)
    selected.unmount()

    const every = await mountScene({ backend, store })
    every.render(<RouterProvider router={aircraftAt('/')} />)
    await waitFor(() => {
      every.advance()
      expect(drawnEast(every)).toHaveLength(2)
    })
    expect(drawnEast(every).map((east) => Math.round(east))).toEqual([0, 50])
    every.unmount()
  })
})
