import CameraControls from 'camera-controls'
import {
  Box3,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
} from 'three'

import {
  FIELD_OF_VIEW_DEG,
  FRAME_DISTANCE_M,
  INSPECTOR_SPAN_PX,
  PANEL_SPAN_PX,
  RAIL_SPAN_PX,
  CEILING_M,
  clearPolarAngle,
  coveredBy,
  configureControls,
  flyTo,
  follow,
  framePose,
  keepAboveTerrain,
  lowestCameraHeightM,
  overviewPose,
  unpinsOn,
} from './camera'
import { replaySample } from '../telemetry/replay'
import { takeoffAfter } from '../telemetry/store'
import { drawnAt } from './aircraft'
import { FLAT_SITE, type Site } from './site'

CameraControls.install({
  THREE: { Box3, Matrix4, Quaternion, Raycaster, Sphere, Spherical, Vector2, Vector3, Vector4 },
})

/**
 * A 300 m hill north-east of the origin and rolling ground around it, up to some
 * 50° steep: steeper than the camera's lowest pitch, so only the terrain's own
 * limit keeps the camera out of it.
 */
const HILLS: Site = {
  halfSizeM: 1000,
  ground: (x, z) =>
    300 * Math.exp(-((x - 250) ** 2 + (z + 250) ** 2) / (2 * 220 ** 2)) +
    25 * Math.sin(x / 60) * Math.cos(z / 45),
  lowestM: -25,
  highestM: 325,
  spacingM: 8,
}

function controlsOver(site = FLAT_SITE): [CameraControls, PerspectiveCamera] {
  const camera = new PerspectiveCamera(FIELD_OF_VIEW_DEG, 16 / 9, 1, 20000)
  const controls = new CameraControls(camera, document.createElement('div'))
  configureControls(controls, site, true)
  void flyTo(controls, overviewPose(site), site, false)
  controls.update(0)
  return [controls, camera]
}

/** A seeded generator, so a failing sequence replays exactly. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32
    return state / 2 ** 32
  }
}

describe('the camera (FR-SCN-03)', () => {
  it('starts over the whole site, looking north at the design pitch', () => {
    const { position, target } = overviewPose(FLAT_SITE)
    expect(target.toArray()).toEqual([0, 0, 0])
    expect(position.x).toBe(0)
    expect(position.z).toBeGreaterThan(0)
    const pitch = Math.atan2(position.y, position.z) * (180 / Math.PI)
    expect(pitch).toBeCloseTo(50, 6)
    const halfView = Math.atan(FLAT_SITE.halfSizeM / position.length()) * (180 / Math.PI)
    expect(halfView).toBeLessThan(FIELD_OF_VIEW_DEG / 2)
  })

  it('stays above the ground and over the site under any input', () => {
    const [controls, camera] = controlsOver()
    const next = random(20261011)
    const span = (size: number) => (next() - 0.5) * 2 * size
    const lowest = lowestCameraHeightM()
    const site = new Box3(
      new Vector3(-FLAT_SITE.halfSizeM, 0, -FLAT_SITE.halfSizeM),
      new Vector3(FLAT_SITE.halfSizeM, Infinity, FLAT_SITE.halfSizeM),
    )
    const operations = [
      () => controls.rotate(span(Math.PI), span(Math.PI), false),
      () => controls.dolly(span(5000), false),
      () => controls.truck(span(5000), span(5000), false),
      () => {
        const position = new Vector3(span(3000), -Math.abs(span(500)), span(3000))
        const target = new Vector3(span(5000), span(500), span(5000))
        return flyTo(controls, { position, target }, FLAT_SITE, false)
      },
    ]
    for (let step = 0; step < 2000; step += 1) {
      void operations[Math.floor(next() * operations.length)]?.()
      controls.update(1 / 60)
      const target = controls.getTarget(new Vector3())
      expect(camera.position.y, `step ${String(step)}`).toBeGreaterThanOrEqual(lowest - 1e-6)
      expect(site.containsPoint(target), `step ${String(step)}`).toBe(true)
    }
  })

  it('stays over the terrain, its target never under it, under any input (2,000 steps)', () => {
    const [controls, camera] = controlsOver(HILLS)
    const next = random(20261012)
    const span = (size: number) => (next() - 0.5) * 2 * size
    const clearance = lowestCameraHeightM()
    // The control event's listener, as Controls wires it after every gesture.
    let kept = 0
    const gesture = (input: () => unknown) => () => {
      input()
      const before = controls.getSpherical(new Spherical(), true).phi
      keepAboveTerrain(controls, HILLS)
      if (controls.getSpherical(new Spherical(), true).phi < before) kept += 1
    }
    const operations = [
      gesture(() => controls.rotate(span(Math.PI), span(Math.PI), false)),
      gesture(() => controls.dolly(span(3000), false)),
      gesture(() => controls.truck(span(1500), span(1500), false)),
      () => {
        const position = new Vector3(span(1500), span(600), span(1500))
        const target = new Vector3(span(1500), span(600), span(1500))
        void flyTo(controls, { position, target }, HILLS, false)
      },
    ]
    for (let step = 0; step < 2000; step += 1) {
      operations[Math.floor(next() * operations.length)]?.()
      controls.update(1 / 60)
      const target = controls.getTarget(new Vector3())
      const below = (point: Vector3) => HILLS.ground(point.x, point.z)
      const where = `step ${String(step)}`
      expect(camera.position.y - below(camera.position), where).toBeGreaterThanOrEqual(
        clearance - 1e-4,
      )
      expect(target.y - below(target), where).toBeGreaterThanOrEqual(-1e-6)
      expect(Math.max(Math.abs(target.x), Math.abs(target.z)), where).toBeLessThanOrEqual(1000)
      expect(target.y, where).toBeLessThanOrEqual(HILLS.highestM + CEILING_M)
    }
    // The terrain itself held the camera, beyond the pitch's limit, again and again.
    expect(kept).toBeGreaterThan(20)
  })

  it('looks down only as much more steeply as the terrain behind the camera needs', () => {
    // The ground rises 1 m every metre south of z = 0: behind a camera looking north.
    const slope: Site = { ...HILLS, ground: (_x, z) => Math.max(0, z) }
    const target = new Vector3(0, 0, 0)
    const low = new Spherical(100, Math.PI / 2 - 0.2, 0)
    const phi = clearPolarAngle(slope, target, low)
    expect(phi).toBeLessThan(low.phi)
    const camera = new Vector3().setFromSpherical(low.clone().set(100, phi, 0))
    expect(camera.y - camera.z).toBeCloseTo(lowestCameraHeightM(), 1)
    expect(camera.y - camera.z).toBeGreaterThanOrEqual(lowestCameraHeightM() - 1e-6)
    // Over flat ground, the pitch and distance limits already hold it: nothing changes.
    const steepest = new Spherical(20, Math.PI / 2 - (10 * Math.PI) / 180, 1)
    expect(clearPolarAngle(FLAT_SITE, target, steepest)).toBe(steepest.phi)
  })

  it('flies to a target under a hill on the hill instead, the camera over it', () => {
    const [controls, camera] = controlsOver(HILLS)
    void flyTo(
      controls,
      { position: new Vector3(250, 100, -50), target: new Vector3(250, 0, -250) },
      HILLS,
      false,
    )
    controls.update(1 / 60)
    const target = controls.getTarget(new Vector3())
    expect(target.y).toBeCloseTo(HILLS.ground(250, -250), 6)
    expect(camera.position.y - HILLS.ground(camera.position.x, camera.position.z)).toBeGreaterThan(
      lowestCameraHeightM() - 1e-4,
    )
  })

  it("needs flyTo: camera-controls' own setLookAt takes the camera underground", () => {
    const [controls, camera] = controlsOver()
    // eslint-disable-next-line no-restricted-syntax -- what flyTo exists to prevent
    void controls.setLookAt(0, -200, 300, 0, 0, 0, false)
    controls.update(1 / 60)
    expect(camera.position.y).toBeLessThan(0)
    void flyTo(
      controls,
      { position: new Vector3(0, -200, 300), target: new Vector3() },
      FLAT_SITE,
      false,
    )
    controls.update(1 / 60)
    expect(camera.position.y).toBeGreaterThanOrEqual(lowestCameraHeightM() - 1e-6)
  })

  it('is at least a few metres up at its closest and lowest', () => {
    expect(lowestCameraHeightM()).toBeGreaterThan(3)
  })
})

/** Real camera-controls on a camera of the viewport's aspect, started at the overview. */
function lensOver(viewport: {
  width: number
  height: number
}): [CameraControls, PerspectiveCamera] {
  const camera = new PerspectiveCamera(FIELD_OF_VIEW_DEG, viewport.width / viewport.height, 1, 2e4)
  const controls = new CameraControls(camera, document.createElement('div'))
  configureControls(controls, FLAT_SITE, true)
  void flyTo(controls, overviewPose(FLAT_SITE), FLAT_SITE, false)
  controls.update(0)
  return [controls, camera]
}

/** Where `point` lands on the screen, in pixels from the top left. */
function onScreen(
  point: Vector3,
  camera: PerspectiveCamera,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  camera.updateMatrixWorld()
  const seen = point.clone().project(camera)
  return { x: ((seen.x + 1) / 2) * viewport.width, y: ((1 - seen.y) / 2) * viewport.height }
}

const VIEWPORT = { width: 1440, height: 900 }
const FREE_MIDDLE = (RAIL_SPAN_PX + VIEWPORT.width - INSPECTOR_SPAN_PX) / 2

describe('flying to an aircraft (FR-SCN-05)', () => {
  it('frames it in the middle of the view the cards leave free, at the angle the user chose', () => {
    const [controls, camera] = lensOver(VIEWPORT)
    const chosen = controls.getPosition(new Vector3()).sub(controls.getTarget(new Vector3()))
    const subject = new Vector3(320, 40, -150)
    const pose = framePose(
      subject,
      { position: controls.getPosition(new Vector3()), target: controls.getTarget(new Vector3()) },
      VIEWPORT,
    )
    // The camera orbits the subject itself; the view, not the target, is shifted aside.
    expect(pose.target.toArray()).toEqual(subject.toArray())
    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(FRAME_DISTANCE_M, 6)
    const kept = pose.position.clone().sub(pose.target).normalize()
    expect(kept.distanceTo(chosen.normalize())).toBeLessThan(1e-9)

    void flyTo(controls, pose, FLAT_SITE, false)
    controls.update(0)
    const seen = onScreen(subject, camera, VIEWPORT)
    expect(seen.x).toBeCloseTo(FREE_MIDDLE, 0)
    expect(seen.y).toBeCloseTo(VIEWPORT.height / 2, 0)

    const beside = framePose(
      subject,
      { position: controls.getPosition(new Vector3()), target: controls.getTarget(new Vector3()) },
      VIEWPORT,
      coveredBy(true),
    )
    void flyTo(controls, beside, FLAT_SITE, false)
    controls.update(0)
    expect(onScreen(subject, camera, VIEWPORT).x).toBeCloseTo(
      (PANEL_SPAN_PX + VIEWPORT.width - INSPECTOR_SPAN_PX) / 2,
      0,
    )
  })

  it('centres it on a view too narrow to leave room between the cards', () => {
    const camera = { position: new Vector3(0, 300, 300), target: new Vector3(0, 0, 0) }
    const pose = framePose(new Vector3(10, 0, 10), camera, { width: 600, height: 900 })
    expect(pose.target.toArray()).toEqual([10, 0, 10])
    expect(pose.sideM).toBe(0)
  })

  it('goes back to a straight view for the overview', () => {
    const [controls, camera] = lensOver(VIEWPORT)
    const subject = new Vector3(100, 30, 100)
    const camera0 = {
      position: controls.getPosition(new Vector3()),
      target: controls.getTarget(new Vector3()),
    }
    void flyTo(controls, framePose(subject, camera0, VIEWPORT), FLAT_SITE, false)
    void flyTo(controls, overviewPose(FLAT_SITE), FLAT_SITE, false)
    controls.update(0)
    expect(controls.getFocalOffset(new Vector3()).toArray()).toEqual([0, 0, 0])
    expect(onScreen(new Vector3(0, 0, 0), camera, VIEWPORT).x).toBeCloseTo(VIEWPORT.width / 2, 0)
  })
})

describe('following a pinned aircraft (FR-SCN-05)', () => {
  const farm = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
  const thresholds = { telemetryStaleAfterMs: 3000, telemetryLostAfterMs: 10000 }

  // Samples at 5 Hz, received as taken; frames at 30 Hz, the aircraft drawn as the scene draws it.
  const at = (ms: number) => {
    const index = Math.floor(ms / 200)
    const track = {
      latest: { sample: replaySample(farm, index, 0), receivedAt: index * 200, dueAt: index * 200 },
      previous:
        index === 0
          ? null
          : {
              sample: replaySample(farm, index - 1, 0),
              receivedAt: index * 200 - 200,
              dueAt: index * 200 - 200,
            },
      // The replay stands idle where its circle starts, and takes off there.
      takeoff: takeoffAfter(null, replaySample(farm, 0, 0)),
    }
    const drawn = drawnAt(track, farm, ms, thresholds)
    if (drawn === null) throw new Error('nothing drawn')
    return new Vector3(drawn.placement.x, drawn.placement.y, drawn.placement.z)
  }

  /** Flies a pinned replay for `seconds`, `gesture` acting on the camera every frame. */
  function fly(seconds: number, gesture: (controls: CameraControls, frame: number) => void) {
    const [controls, camera] = lensOver(VIEWPORT)
    const start = {
      position: controls.getPosition(new Vector3()),
      target: controls.getTarget(new Vector3()),
    }
    void flyTo(controls, framePose(at(0), start, VIEWPORT), FLAT_SITE, false)
    controls.update(0)
    const visible = VIEWPORT.width - RAIL_SPAN_PX - INSPECTOR_SPAN_PX
    const worst = { x: 0, y: 0 }
    let previous = at(0)
    let frame = 0
    for (let ms = 1000 / 30; ms <= seconds * 1000; ms += 1000 / 30) {
      const subject = at(ms)
      gesture(controls, frame)
      follow(controls, previous, subject, FLAT_SITE, VIEWPORT, coveredBy(false))
      controls.update(1 / 30)
      previous = subject
      const seen = onScreen(subject, camera, VIEWPORT)
      worst.x = Math.max(worst.x, Math.abs(seen.x - FREE_MIDDLE))
      worst.y = Math.max(worst.y, Math.abs(seen.y - VIEWPORT.height / 2))
      frame += 1
    }
    return { worst, visible }
  }

  it('keeps one flying at 15 m/s in the central fifth of the view for a 60 s replayed track', () => {
    const { worst, visible } = fly(60, () => undefined)
    // The central fifth of the view the cards leave free: a tenth either side of its middle.
    expect(worst.x).toBeLessThanOrEqual(visible / 10)
    expect(worst.y).toBeLessThanOrEqual(VIEWPORT.height / 10)
  })

  it('lets the user orbit it and come closer while it flies, keeping it in the middle', () => {
    // Half a turn round it, tilting down, and closer, over 20 s: the user's own gestures.
    const { worst, visible } = fly(20, (controls, frame) => {
      void controls.rotate(Math.PI / 600, frame % 2 === 0 ? 0.001 : -0.0005, true)
      if (frame % 30 === 0) void controls.dolly(5, true)
    })
    expect(worst.x).toBeLessThanOrEqual(visible / 10)
    expect(worst.y).toBeLessThanOrEqual(VIEWPORT.height / 10)
  })

  it('lets go when the map is panned, and only then', () => {
    const { ACTION } = CameraControls
    expect(unpinsOn(ACTION.ROTATE)).toBe(false)
    expect(unpinsOn(ACTION.DOLLY)).toBe(false)
    expect(unpinsOn(ACTION.TOUCH_ROTATE)).toBe(false)
    expect(unpinsOn(ACTION.NONE)).toBe(false)
    expect(unpinsOn(ACTION.TRUCK)).toBe(true)
    expect(unpinsOn(ACTION.SCREEN_PAN)).toBe(true)
    expect(unpinsOn(ACTION.TOUCH_DOLLY_TRUCK)).toBe(true)
  })
})
