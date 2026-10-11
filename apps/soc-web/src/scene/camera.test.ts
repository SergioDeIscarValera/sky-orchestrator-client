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
  coveredBy,
  configureControls,
  flyTo,
  follow,
  framePose,
  lowestCameraHeightM,
  overviewPose,
} from './camera'
import { replaySample } from '../telemetry/replay'
import { takeoffAfter } from '../telemetry/store'
import { drawnAt } from './aircraft'
import { FLAT_SITE } from './site'

CameraControls.install({
  THREE: { Box3, Matrix4, Quaternion, Raycaster, Sphere, Spherical, Vector2, Vector3, Vector4 },
})

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

describe('flying to an aircraft (FR-SCN-05)', () => {
  it('frames it in the middle of the view the cards leave free, at the angle the user chose', () => {
    const viewport = { width: 1440, height: 900 }
    const camera = { position: new Vector3(200, 400, 600), target: new Vector3(0, 0, 0) }
    const subject = new Vector3(320, 40, -150)
    const pose = framePose(subject, camera, viewport)

    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(FRAME_DISTANCE_M, 6)
    const chosen = camera.position.clone().sub(camera.target).normalize()
    const kept = pose.position.clone().sub(pose.target).normalize()
    expect(kept.distanceTo(chosen)).toBeLessThan(1e-9)

    const lens = new PerspectiveCamera(FIELD_OF_VIEW_DEG, viewport.width / viewport.height, 1, 1e5)
    lens.position.copy(pose.position)
    lens.lookAt(pose.target)
    lens.updateMatrixWorld()
    const seen = subject.clone().project(lens)
    const pixelX = ((seen.x + 1) / 2) * viewport.width
    const pixelY = ((1 - seen.y) / 2) * viewport.height
    expect(pixelX).toBeCloseTo((RAIL_SPAN_PX + viewport.width - INSPECTOR_SPAN_PX) / 2, 0)
    expect(pixelY).toBeCloseTo(viewport.height / 2, 0)

    const beside = framePose(subject, camera, viewport, coveredBy(true))
    lens.position.copy(beside.position)
    lens.lookAt(beside.target)
    lens.updateMatrixWorld()
    const besidePanel = ((subject.clone().project(lens).x + 1) / 2) * viewport.width
    expect(besidePanel).toBeCloseTo((PANEL_SPAN_PX + viewport.width - INSPECTOR_SPAN_PX) / 2, 0)
  })

  it('centres it on a view too narrow to leave room between the cards', () => {
    const camera = { position: new Vector3(0, 300, 300), target: new Vector3(0, 0, 0) }
    const pose = framePose(new Vector3(10, 0, 10), camera, { width: 600, height: 900 })
    expect(pose.target.toArray()).toEqual([10, 0, 10])
  })
})

describe('following a pinned aircraft (FR-SCN-05)', () => {
  it('keeps one flying at 15 m/s in the central fifth of the view for a 60 s replayed track', () => {
    const viewport = { width: 1440, height: 900 }
    const farm = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
    const thresholds = { telemetryStaleAfterMs: 3000, telemetryLostAfterMs: 10000 }
    const camera = new PerspectiveCamera(
      FIELD_OF_VIEW_DEG,
      viewport.width / viewport.height,
      1,
      2e4,
    )
    const controls = new CameraControls(camera, document.createElement('div'))
    configureControls(controls, FLAT_SITE, true)
    void flyTo(controls, overviewPose(FLAT_SITE), FLAT_SITE, false)
    controls.update(0)

    // Samples at 5 Hz, received as taken; frames at 30 Hz, the aircraft drawn as the scene draws it.
    const at = (ms: number) => {
      const index = Math.floor(ms / 200)
      const track = {
        latest: { sample: replaySample(farm, index, 0), receivedAt: index * 200 },
        previous:
          index === 0
            ? null
            : { sample: replaySample(farm, index - 1, 0), receivedAt: index * 200 - 200 },
        // The replay stands idle where its circle starts, and takes off there.
        takeoff: takeoffAfter(null, replaySample(farm, 0, 0)),
      }
      const drawn = drawnAt(track, farm, ms, thresholds)
      if (drawn === null) throw new Error('nothing drawn')
      return new Vector3(drawn.placement.x, drawn.placement.y, drawn.placement.z)
    }
    const pose = framePose(
      at(0),
      {
        position: controls.getPosition(new Vector3()),
        target: controls.getTarget(new Vector3()),
      },
      viewport,
    )
    void flyTo(controls, pose, FLAT_SITE, false)
    controls.update(0)

    const visible = viewport.width - RAIL_SPAN_PX - INSPECTOR_SPAN_PX
    const middle = RAIL_SPAN_PX + visible / 2
    const worst = { x: 0, y: 0 }
    let previous = at(0)
    for (let ms = 1000 / 30; ms <= 60_000; ms += 1000 / 30) {
      const subject = at(ms)
      void follow(controls, previous, subject, FLAT_SITE)
      controls.update(1 / 30)
      previous = subject
      camera.updateMatrixWorld()
      const seen = subject.clone().project(camera)
      const x = ((seen.x + 1) / 2) * viewport.width - middle
      const y = ((1 - seen.y) / 2) * viewport.height - viewport.height / 2
      worst.x = Math.max(worst.x, Math.abs(x))
      worst.y = Math.max(worst.y, Math.abs(y))
    }
    // The central fifth of the view the cards leave free: a tenth either side of its middle.
    expect(worst.x).toBeLessThanOrEqual(visible / 10)
    expect(worst.y).toBeLessThanOrEqual(viewport.height / 10)
  })
})
