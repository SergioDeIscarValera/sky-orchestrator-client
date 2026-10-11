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
  configureControls,
  flyTo,
  lowestCameraHeightM,
  overviewPose,
} from './camera'
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
