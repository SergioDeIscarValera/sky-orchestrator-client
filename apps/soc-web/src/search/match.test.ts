// @vitest-environment node
import type { Fleet } from '../backend/backend'
import { device, MAVIC_AIR_2, MINI_2 } from '../test/FakeBackend'
import { marked, matching, MAX_FOUND, normalise, rank, search, searchables } from './match'

function fleet(id: string, name: string, aircraftSn: string, changes: Partial<Fleet> = {}): Fleet {
  return {
    id,
    name,
    model: MAVIC_AIR_2.model,
    airframeSerial: `AF-${aircraftSn}`,
    controllerSerial: null,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    flightTimeBeforeSocS: 0,
    createdAt: '2026-10-11T08:10:00Z',
    updatedAt: '2026-10-11T08:10:00Z',
    ...changes,
  }
}

const FLEETS = [
  fleet('f1', 'Norte 1', '1WNBH9E00A0042'),
  fleet('f2', 'Peñas Altas', '1WNBH9E00A0077', { model: MINI_2.model, controllerSerial: 'RC-77' }),
  fleet('f3', 'Norte 2', '3YTBJ7R0021ZK9'),
]
const DEVICES = [
  device('1WNBH9E00A0042'),
  device('1WNBH9E00A0077'),
  device('3YTBJ7R0021ZK9'),
  device('9NORTE00000001'),
  {
    ...device('REPLAYUAV'),
    gatewaySn: 'REPLAYDOCK',
    stack: { ...device('X').stack, name: 'replay' },
  },
]
const ENTRIES = searchables(FLEETS, DEVICES, [MAVIC_AIR_2, MINI_2])
const titles = (query: string) => search(ENTRIES, query).map(({ title }) => title)

describe('the search over the organization (FR-SCN-05, NFR-UX-03)', () => {
  it('lists the fleets by name, then the aircraft in no fleet by serial, as the panel does', () => {
    expect(titles('')).toEqual(['Norte 1', 'Norte 2', 'Peñas Altas', '9NORTE00000001', 'REPLAYUAV'])
    expect(search(ENTRIES, 'replay')[0]).toEqual({
      key: 'device:REPLAYDOCK/REPLAYUAV',
      selection: { kind: 'device', gatewaySn: 'REPLAYDOCK', aircraftSn: 'REPLAYUAV' },
      aircraft: 'REPLAYDOCK/REPLAYUAV',
      title: 'REPLAYUAV',
      detail: 'Not registered · via replay',
      kind: 'Aircraft',
    })
    expect(search(ENTRIES, 'penas')[0]).toMatchObject({
      selection: { kind: 'fleet', fleetId: 'f2' },
      detail: 'DJI Mini 2 · 1WNBH9E00A0077',
      kind: 'Fleet',
    })
  })

  it('finds a fleet by name, model, aircraft, airframe or controller serial, accents and case aside', () => {
    expect(titles('PEÑAS')).toEqual(['Peñas Altas'])
    expect(titles('penas altas')).toEqual(['Peñas Altas'])
    expect(titles('  penas   altas ')).toEqual(['Peñas Altas'])
    expect(titles('mini')).toEqual(['Peñas Altas'])
    expect(titles('a0077')).toEqual(['Peñas Altas'])
    expect(titles('af-3ytbj')).toEqual(['Norte 2'])
    expect(titles('rc-77')).toEqual(['Peñas Altas'])
    expect(titles('mavic air')).toEqual(['Norte 1', 'Norte 2'])
  })

  it('ranks a whole word first, then a start, then inside, then spread over several', () => {
    // `norte 1` is Norte 1's name; Norte 2 and 9NORTE have `norte` and a `1` apart.
    expect(titles('norte 1')).toEqual(['Norte 1', 'Norte 2', '9NORTE00000001'])
    // `norte` starts both fleets and lies inside 9NORTE.
    expect(titles('norte')).toEqual(['Norte 1', 'Norte 2', '9NORTE00000001'])
    expect(titles('1wnbh9')).toEqual(['Norte 1', 'Peñas Altas'])
    expect(rank(['norte 1'], 'norte 1')).toBe(0)
    expect(rank(['norte 1'], 'norte')).toBe(1)
    expect(rank(['penas altas'], 'altas')).toBe(1)
    expect(rank(['9norte00000001'], 'norte')).toBe(2)
    expect(rank(['norte 1', 'dji mavic air 2'], 'mavic norte')).toBe(3)
    expect(rank(['norte 1'], 'sur')).toBeNull()
    expect(rank(['norte 1'], 'norte sur')).toBeNull()
  })

  it('never lists a registered aircraft twice, nor more than the cap', () => {
    expect(titles('1WNBH9E00A0042')).toEqual(['Norte 1'])
    const many = searchables(
      [],
      Array.from({ length: 20 }, (_, index) => device(`UAV${String(index).padStart(2, '0')}`)),
      [],
    )
    expect(search(many, 'uav')).toHaveLength(MAX_FOUND)
    expect(search(many, '')).toHaveLength(MAX_FOUND)
  })

  it('names a model it does not know by its key', () => {
    const unknown = searchables([fleet('f9', 'Sur', 'X1', { model: 'agras-t50' })], [], [])
    expect(search(unknown, 'agras')[0]?.detail).toBe('agras-t50 · X1')
  })

  it('marks where the query is in the title, accents and case aside', () => {
    expect(marked('Peñas Altas', 'PENAS')).toEqual(['', 'Peñas', ' Altas'])
    expect(marked('Peñas Altas', 'as al')).toEqual(['Peñ', 'as Al', 'tas'])
    expect(marked('Norte 1', 'te')).toEqual(['Nor', 'te', ' 1'])
    expect(marked('Norte 1', 'mavic')).toEqual(['Norte 1'])
    expect(marked('Norte 1', '')).toEqual(['Norte 1'])
    // A title written with a combining accent marks the accent with its letter.
    expect(marked('Peñas', 'pen')).toEqual(['', 'Peñ', 'as'])
    expect(normalise('Peñas')).toBe('penas')
  })
})

describe('the matching over any named entries (FR-GEO-03)', () => {
  const named = (names: readonly string[]) =>
    names.map((name) => ({ name, words: [normalise(name)] }))
  type Named = ReturnType<typeof named>[number]
  const names = (query: string, entries: readonly Named[]) =>
    matching(entries, query).map(({ name }) => name)

  it('keeps every match, where search stops at the cap, and ranks them as search does', () => {
    const rows = named(
      Array.from(
        { length: 3 * MAX_FOUND },
        (_, index) => `Row ${String(index + 1).padStart(2, '0')}`,
      ),
    )
    expect(matching(rows, 'row')).toHaveLength(3 * MAX_FOUND)
    expect(matching(rows, '')).toHaveLength(3 * MAX_FOUND)
    expect(names('ridge', named(['Ridge 2', 'Corridor 1', 'Ridge']))).toEqual(['Ridge', 'Ridge 2'])
  })

  it('finds by the folded name, and finds nothing when a word of the query is in no name', () => {
    const entries = named(['Peñas Altas', 'Norte 1'])
    expect(names('PENAS  altas', entries)).toEqual(['Peñas Altas'])
    expect(names('norte sur', entries)).toEqual([])
    expect(names('   ', entries)).toEqual(['Peñas Altas', 'Norte 1'])
  })

  it('leaves the entries it is given as they were', () => {
    const entries = named(['Norte 1', 'Peñas Altas'])
    const before = [...entries]
    matching(entries, 'norte')
    matching(entries, '')
    expect(entries).toEqual(before)
  })
})
