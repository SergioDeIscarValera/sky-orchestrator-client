import { ordered } from './postgrest-order.mjs'

describe("the fake's PostgREST order", () => {
  const rows = [
    { id: 'a', name: 'Norte 2', at: '2026-10-11T10:00:02.000Z', speed: 10 },
    { id: 'b', name: 'Norte 1', at: '2026-10-11T10:00:00.500Z', speed: null },
    { id: 'c', name: 'Almendral', at: '2026-10-11T10:00:01.000+00:00', speed: 4 },
  ]
  const ids = (list: readonly { id: string }[]) => list.map(({ id }) => id)

  it('keeps the stored order when none is named', () => {
    expect(ids(ordered(rows, null))).toEqual(['a', 'b', 'c'])
    expect(ids(ordered(rows, ''))).toEqual(['a', 'b', 'c'])
  })

  it('runs a column ascending unless it says desc', () => {
    expect(ids(ordered(rows, 'name'))).toEqual(['c', 'b', 'a'])
    expect(ids(ordered(rows, 'name.asc'))).toEqual(['c', 'b', 'a'])
    expect(ids(ordered(rows, 'name.desc'))).toEqual(['a', 'b', 'c'])
  })

  it('orders timestamps by time, whatever their offset is written as', () => {
    expect(ids(ordered(rows, 'at.desc'))).toEqual(['a', 'c', 'b'])
    expect(ids(ordered(rows, 'at.asc'))).toEqual(['b', 'c', 'a'])
  })

  it('puts nulls last ascending and first descending, unless it is told where', () => {
    expect(ids(ordered(rows, 'speed'))).toEqual(['c', 'a', 'b'])
    expect(ids(ordered(rows, 'speed.desc'))).toEqual(['b', 'a', 'c'])
    expect(ids(ordered(rows, 'speed.desc.nullslast'))).toEqual(['a', 'c', 'b'])
    expect(ids(ordered(rows, 'speed.asc.nullsfirst'))).toEqual(['b', 'c', 'a'])
  })

  it('lets the next column decide a tie, and keeps the stored order of a full tie', () => {
    const tied = [
      { id: 'x', group: 1, name: 'b' },
      { id: 'y', group: 1, name: 'a' },
      { id: 'z', group: 0, name: 'c' },
      { id: 'w', group: 1, name: 'a' },
    ]
    expect(ids(ordered(tied, 'group,name'))).toEqual(['z', 'y', 'w', 'x'])
    expect(ids(ordered(tied, 'group.desc, name.desc'))).toEqual(['x', 'y', 'w', 'z'])
  })

  it('leaves the rows it is given as they were', () => {
    const stored = [...rows]
    ordered(rows, 'name')
    expect(rows).toEqual(stored)
  })
})
