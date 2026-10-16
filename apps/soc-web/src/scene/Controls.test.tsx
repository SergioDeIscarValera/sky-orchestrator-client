import { RouterProvider } from '@tanstack/react-router'
import { waitFor } from '@testing-library/react'
import { Vector3 } from 'three'

import { createConsoleRouter } from '../app/router'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { createTelemetryStore } from '../telemetry/store'
import { coveredBy } from './camera'
import { useCameraCommands, type SceneBox } from './commands'
import { Controls } from './Controls'
import { OperationFocus } from './OperationFocus'
import { FARM, farmWithOperation, mountScene } from './sceneTestKit'
import { FLAT_SITE } from './site'

const VIEWPORT = { width: 1440, height: 900 }

beforeEach(() => {
  useCameraCommands.setState({ last: null, pinned: null, ready: false })
})

// The worker keeps its modules between files (ADR-0022): a spy a failing test leaves is restored here.
afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Less motion, as a user who asks for it gets (NFR-UX-05): the camera's flights are cuts, so a command
 * is at its pose at once. The spy is the test's own, and is restored when the test ends.
 */
function lessMotion() {
  return vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  )
}

/** The eight corners of a box, as scene points. */
function cornersOf({ min, max }: SceneBox): Vector3[] {
  return [min.x, max.x].flatMap((x) =>
    [min.y, max.y].flatMap((y) => [min.z, max.z].map((z) => new Vector3(x, y, z))),
  )
}

describe('the camera framing a fitted operation (FR-SCN-05)', () => {
  it("turns to the operation's box, in the view the cards leave free, and lets go of a followed aircraft", async () => {
    lessMotion()
    const mounted = await mountScene({
      backend: new FakeBackend(PILOT),
      store: createTelemetryStore(),
      size: VIEWPORT,
    })
    const router = createConsoleRouter(() => (
      <Controls site={FLAT_SITE} organizationId={NORTH.id} />
    ))
    mounted.render(<RouterProvider router={router} />)
    await waitFor(() => {
      expect(mounted.controls()).not.toBeNull()
    })
    expect(useCameraCommands.getState().ready).toBe(true)

    const box: SceneBox = { min: { x: -200, y: 0, z: -200 }, max: { x: 200, y: 60, z: 200 } }
    useCameraCommands.getState().pin('SOTESTDOCK01/SOTESTUAV001')
    useCameraCommands.getState().fit(box)
    mounted.advance()
    expect(useCameraCommands.getState().pinned).toBeNull()

    const target = mounted.controls()?.getTarget(new Vector3())
    expect(target?.x).toBeCloseTo(0, 3)
    expect(target?.y).toBeCloseTo(30, 3)
    expect(target?.z).toBeCloseTo(0, 3)

    const camera = mounted.camera()
    camera.updateMatrixWorld()
    const covered = coveredBy(false)
    for (const corner of cornersOf(box)) {
      const seen = corner.clone().project(camera)
      const x = ((seen.x + 1) / 2) * VIEWPORT.width
      const y = ((1 - seen.y) / 2) * VIEWPORT.height
      expect(x, corner.toArray().join(' ')).toBeGreaterThanOrEqual(covered.leftPx)
      expect(x, corner.toArray().join(' ')).toBeLessThanOrEqual(VIEWPORT.width - covered.rightPx)
      expect(y, corner.toArray().join(' ')).toBeGreaterThanOrEqual(0)
      expect(y, corner.toArray().join(' ')).toBeLessThanOrEqual(VIEWPORT.height)
    }
    mounted.unmount()
  })

  it('frames an operation whose data was read before the camera mounted, in the same commit', async () => {
    lessMotion()
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const queryClient = quietQueryClient()
    // The data is read once, as the console reads it before the scene mounts: a camera was up then, so the
    // focus sent its fit, and the camera is down again.
    useCameraCommands.setState({ ready: true })
    const warm = await mountScene({ backend, store: createTelemetryStore(), queryClient })
    warm.render(<OperationFocus operationId={operation.id} site={FLAT_SITE} origin={FARM} />)
    await waitFor(() => {
      expect(useCameraCommands.getState().last?.command).toBe('fit')
    })
    warm.unmount()
    useCameraCommands.setState({ last: null, ready: false })

    // The focus and the camera mount together, the focus first, with the data already in the cache.
    const mounted = await mountScene({
      backend,
      store: createTelemetryStore(),
      queryClient,
      size: VIEWPORT,
    })
    const router = createConsoleRouter(() => (
      <>
        <OperationFocus operationId={operation.id} site={FLAT_SITE} origin={FARM} />
        <Controls site={FLAT_SITE} organizationId={NORTH.id} />
      </>
    ))
    mounted.render(<RouterProvider router={router} />)
    // The box of the operation: its geofence ring and its planned flight, centred over the farm.
    await waitFor(() => {
      mounted.advance()
      expect(mounted.controls()?.getTarget(new Vector3()).y).toBeCloseTo(15, 3)
    })
    expect(mounted.controls()?.getTarget(new Vector3()).x).toBeCloseTo(0, 3)
    mounted.unmount()
  }, 20_000)
})
