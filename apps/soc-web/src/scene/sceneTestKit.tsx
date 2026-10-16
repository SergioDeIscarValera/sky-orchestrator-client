/**
 * What the scene's tests share: a three.js root under the console's providers, a farm with an operation
 * on it, and the stored and live samples of its flight. Only the tests import it.
 */
import { createRoot, extend, type RootStore } from '@react-three/fiber'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type CameraControlsImpl from 'camera-controls'
import { act, type ReactNode } from 'react'
import * as THREE from 'three'
import type { InterleavedBufferAttribute, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import type { Line2 } from 'three/addons/lines/Line2.js'

import type { Backend, Flight, Organization, TrackPoint } from '../backend/backend'
import { BackendContext } from '../backend/context'
import { SettingsContext } from '../config/settings'
import { bake, type Design } from '../geometry/bake'
import { flightToJson } from '../geometry/designJson'
import { planFlight } from '../geometry/flight'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { OrganizationContext } from '../organizations/context'
import { draftOf } from '../plans/waylines'
import { MAVIC_AIR_2, NORTH, type FakeBackend } from '../test/FakeBackend'
import { quietQueryClient, SETTINGS } from '../test/render'
import { TelemetryContext } from '../telemetry/context'
import type { TelemetrySample } from '../telemetry/sample'
import type { TelemetryStore } from '../telemetry/store'
import { CANVAS_SETTINGS } from './canvas'
import { CaptureScene } from './CaptureScene'

// The Canvas registers three.js's classes as the scene's elements; a root made here does the same.
extend(THREE as unknown as Parameters<typeof extend>[0])

export const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
export const at = (eastM: number, northM: number): Geodetic => geodeticAt(FARM, { eastM, northM })
const START = Date.parse('2026-10-11T10:10:00Z')

/** A takeoff at the farm, then a route 50 m north and across 100 m east: the corridor. */
export const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

/** A geofence of 400 m a side round the corridor. */
const FENCE = [at(-200, -200), at(200, -200), at(200, 200), at(-200, 200)]

/** The flight an assignment stores: from the takeoff, up to 30 m, then the corridor at 10 m/s. */
export const PLANNED = planFlight(DESIGN.takeoff, BAKED, {
  origin: FARM,
  takeoffSecurityHeightM: 30,
  speedMs: 10,
  finishAction: 'return_home',
  envelope: null,
})

/** The flight of the operation's fleet, in the air: not ended, so its track is read and its live samples drawn. */
export function flightOf(operationId: string, fleetId: string): Flight {
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
export function stored(second: number, eastM: number, heightM: number): TrackPoint {
  return {
    sampledAt: new Date(START + second * 1000).toISOString(),
    position: at(eastM, 0),
    heightM,
  }
}

/** A sample the telemetry store holds from the flight's aircraft, taken `second` seconds after the start. */
export function live(second: number, eastM: number, heightM: number): TelemetrySample {
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
 * geofence round it, and an operation (in draft) that flies the wayline with its stored flight.
 */
export async function farmWithOperation(backend: FakeBackend, name = 'North corridor') {
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
    name,
    geofenceId: geofence.id,
    takeoffSecurityHeightM: 30,
  })
  await backend.assign(operation.id, NORTH.id, {
    waylineId: wayline.id,
    fleetId: fleet.id,
    speedMs: 10,
    flight: flightToJson(PLANNED),
  })
  return { fleet, operation, geofence, wayline }
}

const CANVAS_SIZE = { width: 800, height: 600, top: 0, left: 0 }

export interface MountedScene {
  readonly scene: () => Scene
  /** The camera the scene's controls move, with the scene's lens. */
  readonly camera: () => PerspectiveCamera
  /** The camera controls the console's controls hold, or null until they are mounted. */
  readonly controls: () => CameraControlsImpl | null
  /** Runs one frame by hand: a test's root draws no frame of its own (frameloop 'never'). */
  readonly advance: () => void
  readonly render: (element: ReactNode) => void
  readonly unmount: () => void
}

export interface MountOptions {
  readonly backend: Backend
  readonly store: TelemetryStore
  readonly queryClient?: QueryClient
  readonly organization?: Organization
  /** The canvas's size in pixels: the default is small, for the tests that do not frame anything. */
  readonly size?: { readonly width: number; readonly height: number }
}

/**
 * A three.js root of its own, under the console's providers, as the scene is mounted: its renderer is
 * a stub, since the scene's objects exist without a GPU and nothing here is drawn.
 */
export async function mountScene({
  backend,
  store,
  queryClient = quietQueryClient(),
  organization = NORTH,
  size = CANVAS_SIZE,
}: MountOptions): Promise<MountedScene> {
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
  await root.configure({
    gl: renderer,
    size: { ...size, top: 0, left: 0 },
    dpr: 1,
    frameloop: 'never',
    camera: { ...CANVAS_SETTINGS.camera },
  })
  const choice = { organization, organizations: [organization], choose: () => undefined }
  let mounted: { readonly scene: Scene; readonly store: RootStore } | null = null
  const onMounted = (scene: Scene, rootStore: RootStore) => {
    mounted = { scene, store: rootStore }
  }
  const current = () => {
    if (mounted === null) throw new Error('the scene was not mounted')
    return mounted
  }
  return {
    scene: () => current().scene,
    camera: () => current().store.getState().camera as PerspectiveCamera,
    controls: () => current().store.getState().controls as CameraControlsImpl | null,
    advance: () => {
      current().store.getState().advance(performance.now())
    },
    render: (element: ReactNode) => {
      act(() => {
        root.render(
          <SettingsContext value={SETTINGS}>
            <BackendContext value={backend}>
              <QueryClientProvider client={queryClient}>
                <OrganizationContext value={choice}>
                  <TelemetryContext value={store}>
                    <CaptureScene onMounted={onMounted} />
                    {element}
                  </TelemetryContext>
                </OrganizationContext>
              </QueryClientProvider>
            </BackendContext>
          </SettingsContext>,
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
export function verticesOf(line: Line2): number[][] {
  const starts = line.geometry.attributes.instanceStart as InterleavedBufferAttribute
  const ends = line.geometry.attributes.instanceEnd as InterleavedBufferAttribute
  if (starts.count === 0) return []
  const vertices = [[starts.getX(0), starts.getY(0), starts.getZ(0)]]
  for (let index = 0; index < ends.count; index += 1) {
    vertices.push([ends.getX(index), ends.getY(index), ends.getZ(index)])
  }
  return vertices
}
