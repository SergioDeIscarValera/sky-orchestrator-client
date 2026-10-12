// @vitest-environment node
import { ceilingWalls } from './ceiling'
import { FLAT_SITE, type Ground } from './site'

const SQUARE = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: -10 },
  { x: 0, z: -10 },
]

const ys = (walls: Float32Array) => [...walls].filter((_, index) => index % 3 === 1)

describe("a geofence's volume (FR-GEO-01)", () => {
  it('walls every edge of the ring from the ground to the ceiling, back to the first', () => {
    const walls = ceilingWalls(SQUARE, FLAT_SITE.ground, Infinity, 1, 60)
    // Four edges, two triangles each, three corners of three numbers.
    expect(walls).toHaveLength(4 * 2 * 3 * 3)
    expect(new Set(ys(walls))).toEqual(new Set([1, 60]))
  })

  it('follows the ground under each point, cut as the outline is', () => {
    const slope: Ground = (x) => x
    const walls = ceilingWalls(SQUARE, slope, 5, 0, 30)
    expect(walls).toHaveLength(8 * 2 * 3 * 3)
    const corners = [...walls]
    for (let at = 0; at < corners.length; at += 3) {
      const [x = 0, y = 0] = [corners[at], corners[at + 1]]
      expect([x, x + 30]).toContain(y)
    }
  })

  it('is nothing for fewer than three points, or a ceiling not above the lift', () => {
    expect(ceilingWalls(SQUARE.slice(0, 2), FLAT_SITE.ground, Infinity, 1, 60)).toHaveLength(0)
    expect(ceilingWalls(SQUARE, FLAT_SITE.ground, Infinity, 1, 1)).toHaveLength(0)
    expect(ceilingWalls(SQUARE, FLAT_SITE.ground, Infinity, 1, Number.NaN)).toHaveLength(0)
  })
})
