// @vitest-environment node
import { SITE } from '../test/site'
import { FLAT_GROUND, FLAT_SITE, groundOf, heightAt, siteOf } from './site'

describe("the scene's ground (FR-SCN-02, ADR-0014)", () => {
  it('gives the ground under a point, between vertices, and nothing off the site', () => {
    expect(heightAt(SITE, 0, 0)).toBe(0)
    expect(heightAt(SITE, -100, 100)).toBe(10)
    expect(heightAt(SITE, 50, -50)).toBeCloseTo(-5, 6)
    expect(heightAt(SITE, -50, 50)).toBeCloseTo(5, 6)
    expect(heightAt(SITE, 101, 0)).toBeNull()
  })

  it("stands aircraft on it in the scene's axes, and on the nearest edge past it", () => {
    const ground = groundOf(SITE)
    // z is south: the scene's (-50, -50) is the site's 50 m west, 50 m north.
    expect(ground(-50, -50)).toBeCloseTo(5, 6)
    expect(ground(50, 50)).toBeCloseTo(-5, 6)
    expect(ground(-400, -400)).toBe(10)
    expect(ground(400, 0)).toBeCloseTo(-5, 6)
    expect(FLAT_GROUND(-400, 400)).toBe(0)
  })

  it("is the baked model's, with its relief above the origin, or flat without one", () => {
    const site = siteOf(SITE)
    expect(site.halfSizeM).toBe(100)
    expect([site.lowestM, site.highestM, site.spacingM]).toEqual([-10, 10, 100])
    expect(site.ground(-50, -50)).toBeCloseTo(5, 6)
    expect(siteOf(null)).toBe(FLAT_SITE)
    expect(FLAT_SITE.spacingM).toBeNull()
  })
})
