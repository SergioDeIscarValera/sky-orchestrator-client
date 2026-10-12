// @vitest-environment node
import { Ray, Vector3 } from 'three'

import { groundUnder } from './pick'
import { FLAT_GROUND } from './site'

const toward = (from: Vector3, to: Vector3) => new Ray(from, to.clone().sub(from).normalize())

describe('a point picked on the ground (FR-GEO-01, FR-WAY-01)', () => {
  it('meets the flat ground where the ray crosses it', () => {
    const hit = groundUnder(
      toward(new Vector3(0, 100, 0), new Vector3(100, 0, -50)),
      FLAT_GROUND,
      1000,
    )
    expect(hit?.x).toBeCloseTo(100, 3)
    expect(hit?.z).toBeCloseTo(-50, 3)
    expect(hit?.y).toBe(0)
  })

  it('meets a slope where it rises to the ray', () => {
    // A slope rising half a metre a metre east; the ray falls a metre a metre east.
    const slope = (x: number) => 0.5 * x
    const hit = groundUnder(toward(new Vector3(0, 60, 0), new Vector3(60, 0, 0)), slope, 500)
    // 60 - x = 0.5 x at x = 40.
    expect(hit?.x).toBeCloseTo(40, 3)
    expect(hit?.y).toBeCloseTo(20, 3)
  })

  it('meets a ridge before the ground beyond it', () => {
    const ridge = (x: number) => (Math.abs(x - 30) < 3 ? 25 : 0)
    const hit = groundUnder(toward(new Vector3(0, 40, 0), new Vector3(80, 0, 0)), ridge, 500)
    // The ray, 40 - x / 2, clears the ridge's wall at x = 27 (26.5 m) and meets its
    // top, 25 m, at x = 30: long before the ground beyond, at x = 80.
    expect(hit?.x).toBeCloseTo(30, 3)
    expect(hit?.y).toBe(25)
  })

  it('meets nothing looking up, beyond its reach, or from beneath the ground', () => {
    expect(
      groundUnder(toward(new Vector3(0, 10, 0), new Vector3(10, 20, 0)), FLAT_GROUND, 500),
    ).toBeNull()
    expect(
      groundUnder(toward(new Vector3(0, 100, 0), new Vector3(1000, 0, 0)), FLAT_GROUND, 50),
    ).toBeNull()
    expect(
      groundUnder(toward(new Vector3(0, -1, 0), new Vector3(10, -5, 0)), FLAT_GROUND, 500),
    ).toBeNull()
  })
})
