// @vitest-environment node
import { BackendError } from './backend'
import { positionFromStorage, positionToStorage } from './positions'

/** Finca Norte's position, as its organization row holds it: longitude first in the database. */
const FINCA = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

describe('a position between the database and the console (IR-GEO, IR-WAY)', () => {
  it('reads the stored pair longitude first, as GeoJSON orders it', () => {
    expect(positionFromStorage([-4.7245, 41.6523])).toEqual(FINCA)
  })

  it('writes the pair longitude first', () => {
    expect(positionToStorage(FINCA)).toEqual([-4.7245, 41.6523])
  })

  it('round-trips every position, the limits of the ranges included', () => {
    const positions = [
      FINCA,
      { latitudeDeg: 0, longitudeDeg: 0 },
      { latitudeDeg: 90, longitudeDeg: -180 },
      { latitudeDeg: -90, longitudeDeg: 180 },
      { latitudeDeg: 41.652300000001, longitudeDeg: -4.7245 },
    ]
    for (const position of positions) {
      expect(positionFromStorage(positionToStorage(position))).toEqual(position)
    }
  })

  it('accepts the limits of the ranges', () => {
    expect(positionFromStorage([180, -90])).toEqual({ latitudeDeg: -90, longitudeDeg: 180 })
    expect(positionFromStorage([-180, 90])).toEqual({ latitudeDeg: 90, longitudeDeg: -180 })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '[-4.7245, 41.6523]'],
    ['an object', { longitude: -4.7245, latitude: 41.6523 }],
    ['an empty array', []],
    ['one number', [-4.7245]],
    ['three numbers', [-4.7245, 41.6523, 0]],
    ['numbers as text', ['-4.7245', '41.6523']],
    ['a longitude not a number', [null, 41.6523]],
    ['a NaN', [Number.NaN, 41.6523]],
    ['an infinite latitude', [-4.7245, Number.POSITIVE_INFINITY]],
    ['a longitude past 180', [180.0001, 0]],
    ['a longitude below -180', [-180.0001, 0]],
    ['a latitude past 90', [0, 90.0001]],
    ['a latitude below -90', [0, -91]],
  ])('refuses a stored position that is %s, never guessing it', (_, stored) => {
    expect(() => positionFromStorage(stored)).toThrow(BackendError)
    expect(() => positionFromStorage(stored)).toThrow(/cannot read a stored position/)
  })

  it.each([
    ['a NaN latitude', { latitudeDeg: Number.NaN, longitudeDeg: 0 }],
    ['an infinite longitude', { latitudeDeg: 0, longitudeDeg: Number.POSITIVE_INFINITY }],
    ['a latitude past 90', { latitudeDeg: 90.5, longitudeDeg: 0 }],
    ['a longitude below -180', { latitudeDeg: 0, longitudeDeg: -180.5 }],
    ['a missing latitude', { longitudeDeg: 0 } as unknown as typeof FINCA],
  ])('refuses a position to write that has %s', (_, position) => {
    expect(() => positionToStorage(position)).toThrow(BackendError)
    expect(() => positionToStorage(position)).toThrow(/cannot write a position/)
  })
})
