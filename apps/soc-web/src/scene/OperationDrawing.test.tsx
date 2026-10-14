import { createRoot, extend, useThree } from '@react-three/fiber'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import * as THREE from 'three'
import type { InterleavedBufferAttribute, Scene, WebGLRenderer } from 'three'
import type { Line2 } from 'three/addons/lines/Line2.js'

import type { Flight, TrackPoint } from '../backend/backend'
import { BackendContext } from '../backend/context'
import { bake, type Design } from '../geometry/bake'
import { flightToJson } from '../geometry/designJson'
import { planFlight } from '../geometry/flight'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { OrganizationContext } from '../organizations/context'
import { draftOf } from '../plans/waylines'
import { FakeBackend, MAVIC_AIR_2, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { TelemetryContext } from '../telemetry/context'
import type { TelemetrySample } from '../telemetry/sample'
import { createTelemetryStore, type TelemetryStore } from '../telemetry/store'
import { OperationDrawing } from './OperationDrawing'
import { FLAT_SITE } from './site'
import { trackSpots, type Vertex } from './track'

// The Canvas registers three.js's classes as the scene's elements; a root made here does the same.
extend(THREE as unknown as Parameters<typeof extend>[0])

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (eastM: number, northM: number): Geodetic => geodeticAt(FARM, { eastM, northM })
const START = Date.parse('2026-10-11T10:10:00Z')

/** A takeoff at the farm, then a route 50 m north and across 100 m east: the corridor. */
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

const FENCE = [at(-200, -200), at(200, -200), at(200, 200), at(-200, 200)]

/** The flight an assignment stores: from the takeoff, up to 30 m, then the corridor at 10 m/s. */
const PLANNED = planFlight(DESIGN.takeoff, BAKED, {
  origin: FARM,
  takeoffSecurityHeightM: 30,
  speedMs: 10,
  finishAction: 'return_home',
  envelope: null,
})

/** The flight of the operation's fleet, in the air: not ended, so its track is read and its live samples drawn. */
function flightOf(operationId: string, fleetId: string): Flight {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    operationId,
    mode: 'real',
    fleetId,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: new Date(START).toISOString(),
    executedAt: null,
    tookOffAt: null,
    landedAt: null,
    endedAt: null,
    endReason: null,
    breachedAt: null,
  }
}

/** A stored sample of the flight, `second` seconds after the start, `eastM` east of the farm. */
function stored(second: number, eastM: number, heightM: number): TrackPoint {
  return {
    sampledAt: new Date(START + second * 1000).toISOString(),
    position: at(eastM, 0),
    heightM,
  }
}

/** A sample the telemetry store holds from the flight's aircraft, taken `second` seconds after the start. */
function live(second: number, eastM: number, heightM: number): TelemetrySample {
  const position = at(eastM, 0)
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    takenAtMs: START + second * 1000,
    sentAtMs: START + second * 1000 + 40,
    latitudeDeg: position.latitudeDeg,
    longitudeDeg: position.longitudeDeg,
    heightM,
    headingDeg: 0,
    homeDistanceM: 0,
    batteryPct: 90,
    satellites: 14,
    gpsQuality: 5,
    modeCode: 2,
  }
}

/**
 * Plays the operation the scene draws: Norte 1 with the lab's aircraft, the corridor wayline, a
 * geofence round it, and an operation that flies the wayline with its stored flight.
 */
async function farmWithOperation(backend: FakeBackend) {
  const fleet = await backend.registerFleet(NORTH.id, {
    name: 'Norte 1',
    model: MAVIC_AIR_2.model,
    airframeSerial: '1WNBH9',
    controllerSerial: null,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    flightTimeBeforeSocS: 5400,
  })
  const wayline = await backend.createWayline(NORTH.id, draftOf('North corridor', DESIGN, BAKED))
  const geofence = await backend.createGeofence(NORTH.id, {
    name: 'North fence',
    polygon: FENCE,
    maxHeightM: 120,
    origin: 'drawn',
    marginM: null,
  })
  const operation = await backend.createOperation(NORTH.id, {
    name: 'North corridor',
    geofenceId: geofence.id,
    takeoffSecurityHeightM: 30,
  })
  await backend.assign(operation.id, NORTH.id, {
    waylineId: wayline.id,
    fleetId: fleet.id,
    speedMs: 10,
    flight: flightToJson(PLANNED),
  })
  return { fleet, operation }
}

const CANVAS_SIZE = { width: 800, height: 600, top: 0, left: 0 }

/** Hands the root's scene out of the three.js tree, where the scene's own components read it. */
function Capture({ onScene }: { readonly onScene: (scene: Scene) => void }) {
  const scene = useThree((state) => state.scene)
  useEffect(() => {
    onScene(scene)
  }, [onScene, scene])
  return null
}

/**
 * A three.js root of its own, under the console's providers, as the scene is mounted: its renderer is a
 * stub, since the scene's objects exist without a GPU and nothing here is drawn.
 */
async function mountScene(backend: FakeBackend, store: TelemetryStore) {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const renderer = {
    render: () => undefined,
    setPixelRatio: () => undefined,
    setSize: () => undefined,
    domElement: canvas,
    shadowMap: { enabled: false, type: 0, needsUpdate: false },
    outputColorSpace: '',
    toneMapping: 0,
  } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  await root.configure({ gl: renderer, size: CANVAS_SIZE, dpr: 1, frameloop: 'never' })
  const queryClient = quietQueryClient()
  const choice = { organization: NORTH, organizations: [NORTH], choose: () => undefined }
  let scene: Scene | null = null
  const onScene = (captured: Scene) => {
    scene = captured
  }
  return {
    scene: (): Scene => {
      if (scene === null) throw new Error('the scene was not mounted')
      return scene
    },
    render: (element: ReactNode) => {
      act(() => {
        root.render(
          <BackendContext value={backend}>
            <QueryClientProvider client={queryClient}>
              <OrganizationContext value={choice}>
                <TelemetryContext value={store}>
                  <Capture onScene={onScene} />
                  {element}
                </TelemetryContext>
              </OrganizationContext>
            </QueryClientProvider>
          </BackendContext>,
        )
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      canvas.remove()
    },
  }
}

/** The vertices a line draws, in order: the start of its first segment, then the end of each segment. */
function verticesOf(line: Line2): number[][] {
  const starts = line.geometry.attributes.instanceStart as InterleavedBufferAttribute
  const ends = line.geometry.attributes.instanceEnd as InterleavedBufferAttribute
  if (starts.count === 0) return []
  const vertices = [[starts.getX(0), starts.getY(0), starts.getZ(0)]]
  for (let index = 0; index < ends.count; index += 1) {
    vertices.push([ends.getX(index), ends.getY(index), ends.getZ(index)])
  }
  return vertices
}

describe('the selected operation in the scene (FR-SCN-04, FR-OPS-07)', () => {
  it('draws the geofence and the planned flight of a selected operation, and nothing for none', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWithOperation(backend)
    const mounted = await mountScene(backend, createTelemetryStore())
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
    const mounted = await mountScene(backend, store)
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
    const mounted = await mountScene(backend, store)
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
