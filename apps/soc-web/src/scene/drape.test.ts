// @vitest-environment node
import { draped } from './drape'
import { FLAT_GROUND, type Ground } from './site'

/** A ridge along z: 30 m high at x = 50, falling to 0 at x = 0 and x = 100. */
const RIDGE: Ground = (x) => 30 - Math.abs(x - 50) * 0.6

describe('a line laid over the ground (FR-GEO-01)', () => {
  it('on the flat ground, is its points lifted, back to the first when closed', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 100, z: -100 },
    ]
    expect(draped(square, FLAT_GROUND, Infinity, 1, false)).toEqual([
      [0, 1, 0],
      [100, 1, 0],
      [100, 1, -100],
    ])
    expect(draped(square, FLAT_GROUND, Infinity, 1, true).at(-1)).toEqual([0, 1, 0])
  })

  it('follows the terrain between its vertices, cut every step', () => {
    const line = draped(
      [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
      ],
      RIDGE,
      10,
      0.5,
      false,
    )
    expect(line).toHaveLength(11)
    // Straight from end to end it would pass 30 m under the ridge; laid over, it is on it.
    expect(line[5]).toEqual([50, 30.5, 0])
    for (const [x, y, z] of line) expect(y).toBeCloseTo(RIDGE(x, z) + 0.5, 9)
  })

  it('is nothing for no points, a point for one, and never closes fewer than three', () => {
    expect(draped([], FLAT_GROUND, 5, 1, true)).toEqual([])
    expect(draped([{ x: 3, z: 4 }], FLAT_GROUND, 5, 1, true)).toEqual([[3, 1, 4]])
    expect(
      draped(
        [
          { x: 0, z: 0 },
          { x: 4, z: 0 },
        ],
        FLAT_GROUND,
        5,
        0,
        true,
      ),
    ).toEqual([
      [0, 0, 0],
      [4, 0, 0],
    ])
  })
})
