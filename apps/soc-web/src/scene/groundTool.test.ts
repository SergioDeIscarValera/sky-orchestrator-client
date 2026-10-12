// @vitest-environment node
import { PerspectiveCamera } from 'three'

import type { Geodetic } from '../geometry/projection'
import { flatOf, groundAtPointer, placeOf, useGroundTool, type Click } from './groundTool'
import { FLAT_SITE } from './site'

const RECT = { left: 100, top: 50, width: 800, height: 600 }

/** 100 m up and 100 m south of the origin, looking at it, or level at `lookingAtY` = 100. */
function camera(lookingAtY = 0) {
  const looking = new PerspectiveCamera(50, RECT.width / RECT.height, 2, 20_000)
  looking.position.set(0, 100, 100)
  looking.lookAt(0, lookingAtY, 0)
  looking.updateMatrixWorld()
  return looking
}

describe('the ground under the pointer (FR-GEO-01, FR-WAY-01)', () => {
  it("is where the canvas's centre looks", () => {
    const hit = groundAtPointer(camera(), RECT, 500, 350, FLAT_SITE, 20_000)
    expect(hit?.x).toBeCloseTo(0, 6)
    expect(hit?.y).toBe(0)
    expect(hit?.z).toBeCloseTo(0, 6)
  })

  it('is right of centre on the right half of the canvas, offset by the page', () => {
    const hit = groundAtPointer(camera(), RECT, 700, 350, FLAT_SITE, 20_000)
    expect(hit?.x).toBeGreaterThan(10)
    expect(hit?.z).toBeCloseTo(0, 6)
  })

  it('is nothing in the sky, past the reach, or off the site', () => {
    // Level, the upper half of the canvas is sky.
    expect(groundAtPointer(camera(100), RECT, 500, 200, FLAT_SITE, 20_000)).toBeNull()
    expect(groundAtPointer(camera(100), RECT, 500, 500, FLAT_SITE, 20_000)).not.toBeNull()
    expect(groundAtPointer(camera(), RECT, 500, 350, FLAT_SITE, 100)).toBeNull()
    expect(
      groundAtPointer(camera(), RECT, 500, 350, { ...FLAT_SITE, halfSizeM: 50 }, 20_000),
    ).not.toBeNull()
    // Near the horizon the ray lands far beyond a small site's edge.
    expect(
      groundAtPointer(camera(), RECT, 500, 120, { ...FLAT_SITE, halfSizeM: 50 }, 20_000),
    ).toBeNull()
  })
})

describe('the ground plane on the Earth', () => {
  const ORIGIN: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

  it('puts x east and z south, and finds the point back', () => {
    const northEast = placeOf(ORIGIN, { x: 100, z: -200 })
    expect(northEast.latitudeDeg).toBeGreaterThan(ORIGIN.latitudeDeg)
    expect(northEast.longitudeDeg).toBeGreaterThan(ORIGIN.longitudeDeg)
    const back = flatOf(ORIGIN, northEast)
    expect(back.x).toBeCloseTo(100, 6)
    expect(back.z).toBeCloseTo(-200, 6)
  })
})

describe('the ground tool', () => {
  it('is held by one editor at a time, and let go only by its holder', () => {
    const first = vi.fn<(click: Click) => void>()
    const second = vi.fn<(click: Click) => void>()
    const releaseFirst = useGroundTool.getState().hold(first)
    const releaseSecond = useGroundTool.getState().hold(second)
    releaseFirst()
    expect(useGroundTool.getState().use).toBe(second)
    releaseSecond()
    expect(useGroundTool.getState().use).toBeNull()
  })
})
