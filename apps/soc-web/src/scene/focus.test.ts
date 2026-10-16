import { boundingBox } from './focus'

describe('the box an operation in focus is framed within (FR-SCN-05)', () => {
  it('is none with no point to hold', () => {
    expect(boundingBox([])).toBeNull()
  })

  it('holds every point, from its least corner to its greatest', () => {
    const points = [
      { x: 10, y: 0, z: -40 },
      { x: -200, y: 30, z: 5 },
      { x: 120, y: 12, z: 200 },
    ]
    expect(boundingBox(points)).toEqual({
      min: { x: -200, y: 0, z: -40 },
      max: { x: 120, y: 30, z: 200 },
    })
  })

  it('is a point, for one point', () => {
    expect(boundingBox([{ x: 3, y: 4, z: 5 }])).toEqual({
      min: { x: 3, y: 4, z: 5 },
      max: { x: 3, y: 4, z: 5 },
    })
  })
})
