// @vitest-environment node
import { formatPosition, roleName } from './format'

describe('how an organization is described', () => {
  it.each([
    [{ latitude: 41.6523, longitude: -4.7245 }, '41.6523° N, 4.7245° W'],
    [{ latitude: -33.8688, longitude: 151.2093 }, '33.8688° S, 151.2093° E'],
    [{ latitude: 0, longitude: 0 }, '0.0000° N, 0.0000° E'],
    [null, 'No position set'],
  ])('writes %j as %s', (position, text) => {
    expect(formatPosition(position)).toBe(text)
  })

  it('names every role', () => {
    expect(['owner', 'editor', 'viewer'].map((role) => roleName(role as 'owner'))).toEqual([
      'Owner',
      'Editor',
      'Viewer',
    ])
  })
})
