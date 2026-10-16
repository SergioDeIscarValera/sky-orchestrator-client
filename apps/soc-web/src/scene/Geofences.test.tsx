import { RouterProvider } from '@tanstack/react-router'
import { waitFor } from '@testing-library/react'

import { createConsoleRouter } from '../app/router'
import { GEOFENCES, organizationKey } from '../organizations/scope'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { createTelemetryStore } from '../telemetry/store'
import { Geofences } from './Geofences'
import { FARM, farmWithOperation, mountScene } from './sceneTestKit'
import { FLAT_SITE } from './site'

describe('the geofences the scene shows (FR-GEO-02, FR-SCN-04)', () => {
  it('shows every geofence with the geofence panel open, and none while an operation is selected', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const element = () => <Geofences site={FLAT_SITE} origin={FARM} />

    window.history.replaceState(null, '', '/?panel=geofences')
    const listed = await mountScene({ backend, store: createTelemetryStore() })
    listed.render(<RouterProvider router={createConsoleRouter(element)} />)
    await waitFor(() => {
      expect(listed.scene().getObjectByName('geofence North fence')).toBeDefined()
    })
    listed.unmount()

    // The operation's own geofence is drawn by OperationDrawing alone: the list draws nothing beside it.
    window.history.replaceState(null, '', `/?panel=geofences&operation=${operation.id}`)
    const queryClient = quietQueryClient()
    const focused = await mountScene({ backend, store: createTelemetryStore(), queryClient })
    focused.render(<RouterProvider router={createConsoleRouter(element)} />)
    // The list is read before it can draw anything: once the read is in the cache, React draws what it holds.
    await waitFor(() => {
      expect(queryClient.getQueryData(organizationKey(NORTH.id, GEOFENCES))).toHaveLength(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(focused.scene().getObjectByName('geofence North fence')).toBeUndefined()
    focused.unmount()
  })
})
