import {
  BackendError,
  FieldRefusedError,
  type GeofenceDraft,
  type StateEvent,
  type WaylineDraft,
} from '../backend/backend'
import { FakeBackend, NORTH, ORCHARD, PILOT } from './FakeBackend'

const GEOFENCE: GeofenceDraft = {
  name: 'Norte',
  polygon: [
    { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
    { latitudeDeg: 41.6523, longitudeDeg: -4.71 },
    { latitudeDeg: 41.64, longitudeDeg: -4.71 },
  ],
  maxHeightM: 120,
  origin: 'drawn',
  marginM: null,
}

const WAYLINE: WaylineDraft = {
  name: 'Ronda',
  takeoff: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
  defaultHeightM: 40,
  design: { schema_version: '1.0.0', primitives: [] },
  waypoints: [
    { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 40 },
    { index: 1, position: { latitudeDeg: 41.64, longitudeDeg: -4.71 }, heightM: 45 },
  ],
  metrics: { waypointCount: 2, distanceM: 1234.5 },
  bakeVersion: '1.0.0',
}

/** Every event the organization's state topic carries from now on, in order. */
function heard(backend: FakeBackend, organizationId: string): StateEvent[] {
  const events: StateEvent[] = []
  backend.onState(organizationId, (event) => events.push(event))
  return events
}

async function refusedBy(attempt: Promise<unknown>): Promise<unknown> {
  return attempt.catch((error: unknown) => error)
}

describe('the geofences held in memory (FR-GEO-02, FR-GEO-04)', () => {
  it("lists the organization's geofences by name, a retired one in no list", async () => {
    const backend = new FakeBackend(PILOT)
    await backend.createGeofence(NORTH.id, { ...GEOFENCE, name: 'Sur' })
    const norte = await backend.createGeofence(NORTH.id, GEOFENCE)
    expect((await backend.geofences(NORTH.id)).map(({ name }) => name)).toEqual(['Norte', 'Sur'])
    await backend.retireGeofence(norte.id)
    expect((await backend.geofences(NORTH.id)).map(({ name }) => name)).toEqual(['Sur'])
  })

  it('creates a geofence and announces it on the state topic with its stamps', async () => {
    const backend = new FakeBackend(PILOT)
    const events = heard(backend, NORTH.id)
    const created = await backend.createGeofence(NORTH.id, GEOFENCE)
    expect(created).toMatchObject({ name: 'Norte', origin: 'drawn', marginM: null })
    expect(created.createdAt).toBe(created.updatedAt)
    expect(events).toEqual([
      {
        kind: 'geofence',
        payload: {
          id: created.id,
          name: 'Norte',
          origin: 'drawn',
          updated_at: created.updatedAt,
          deleted_at: null,
        },
      },
    ])
  })

  it('stamps a change later than the write before it, and announces the new name', async () => {
    const backend = new FakeBackend(PILOT)
    const created = await backend.createGeofence(NORTH.id, GEOFENCE)
    const events = heard(backend, NORTH.id)
    const changed = await backend.changeGeofence(created.id, { name: 'Norte Alfa' })
    expect(changed).toEqual({ ...created, name: 'Norte Alfa', updatedAt: changed.updatedAt })
    expect(Date.parse(changed.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt))
    expect(events).toEqual([
      {
        kind: 'geofence',
        payload: {
          id: created.id,
          name: 'Norte Alfa',
          origin: 'drawn',
          updated_at: changed.updatedAt,
          deleted_at: null,
        },
      },
    ])
  })

  it('retires a geofence and announces the stamp as its deleted_at', async () => {
    const backend = new FakeBackend(PILOT)
    const created = await backend.createGeofence(NORTH.id, GEOFENCE)
    const events = heard(backend, NORTH.id)
    await backend.retireGeofence(created.id)
    const [event] = events
    expect(event).toMatchObject({ kind: 'geofence', payload: { id: created.id } })
    expect(event?.payload.deleted_at).toEqual(expect.any(String))
    expect(event?.payload.deleted_at).toBe(event?.payload.updated_at)
  })

  it.each([
    ['a blank name', { name: '  ' }, 'name', 'A geofence needs a name.'],
    [
      'two vertices',
      { polygon: GEOFENCE.polygon.slice(0, 2) },
      'polygon',
      'A geofence needs a polygon of at least three positions, its last not repeating its first.',
    ],
    [
      'a ring closed on its first position',
      { polygon: [...GEOFENCE.polygon, { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }] },
      'polygon',
      'A geofence needs a polygon of at least three positions, its last not repeating its first.',
    ],
    [
      'no height above the takeoff point',
      { maxHeightM: 0 },
      'maxHeightM',
      "A geofence's maximum height must be above zero.",
    ],
    [
      'a margin on a drawn geofence',
      { marginM: 10 },
      'marginM',
      'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
    ],
    [
      'a generated geofence without a margin',
      { origin: 'generated', marginM: null },
      'marginM',
      'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
    ],
    [
      'a generated margin of 4 m',
      { origin: 'generated', marginM: 4 },
      'marginM',
      'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
    ],
    [
      'a generated margin of 101 m',
      { origin: 'generated', marginM: 101 },
      'marginM',
      'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
    ],
  ] as const)('refuses %s, naming its field', async (_, changes, field, message) => {
    const backend = new FakeBackend(PILOT)
    const refusal = await refusedBy(backend.createGeofence(NORTH.id, { ...GEOFENCE, ...changes }))
    expect(refusal).toBeInstanceOf(FieldRefusedError)
    expect(refusal).toMatchObject({ field, message, code: '23514' })
    expect(await backend.geofences(NORTH.id)).toEqual([])
  })

  it('accepts a generated margin at the edges of its range', async () => {
    const backend = new FakeBackend(PILOT)
    const low = await backend.createGeofence(NORTH.id, {
      ...GEOFENCE,
      origin: 'generated',
      marginM: 5,
    })
    const high = await backend.createGeofence(NORTH.id, {
      ...GEOFENCE,
      origin: 'generated',
      marginM: 100,
    })
    expect([low.marginM, high.marginM]).toEqual([5, 100])
  })

  it('refuses a change that breaks a constraint the merged geofence would break', async () => {
    const backend = new FakeBackend(PILOT)
    const created = await backend.createGeofence(NORTH.id, GEOFENCE)
    const refusal = await refusedBy(backend.changeGeofence(created.id, { origin: 'generated' }))
    expect(refusal).toMatchObject({ field: 'marginM' })
    const short = await refusedBy(
      backend.changeGeofence(created.id, { polygon: GEOFENCE.polygon.slice(0, 2) }),
    )
    expect(short).toMatchObject({ field: 'polygon' })
    expect(await backend.geofences(NORTH.id)).toEqual([created])
  })

  it('refuses a viewer to create, and leaves a viewer change and retirement untouched', async () => {
    const backend = new FakeBackend(PILOT)
    // Made where PILOT owns, then placed in the organization where PILOT only reads.
    const theirs = await new FakeBackend(PILOT).createGeofence(NORTH.id, GEOFENCE)
    backend.geofenceRows.set(ORCHARD.id, [theirs])
    const events = heard(backend, ORCHARD.id)
    const created = await refusedBy(backend.createGeofence(ORCHARD.id, GEOFENCE))
    expect(created).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change geofences.',
    })
    const changed = await refusedBy(backend.changeGeofence(theirs.id, { name: 'Mine' }))
    const retired = await refusedBy(backend.retireGeofence(theirs.id))
    for (const refusal of [changed, retired]) {
      expect(refusal).toMatchObject({
        message:
          'Nothing changed: this geofence is not one your role in this organization can change.',
      })
    }
    expect(await backend.geofences(ORCHARD.id)).toEqual([theirs])
    expect(events).toEqual([])
  })

  it('refuses a change or a retirement of a retired geofence, whatever is written', async () => {
    const backend = new FakeBackend(PILOT)
    const created = await backend.createGeofence(NORTH.id, GEOFENCE)
    await backend.retireGeofence(created.id)
    const changed = await refusedBy(backend.changeGeofence(created.id, { name: 'Norte Alfa' }))
    const retired = await refusedBy(backend.retireGeofence(created.id))
    for (const refusal of [changed, retired]) {
      expect(refusal).toMatchObject({
        field: null,
        code: '23514',
        message: 'A retired geofence does not change.',
      })
    }
  })

  it('says no geofence it does not hold', async () => {
    const backend = new FakeBackend(PILOT)
    await expect(backend.changeGeofence('no-such-id', { name: 'x' })).rejects.toThrow(BackendError)
    await expect(backend.retireGeofence('no-such-id')).rejects.toThrow('no geofence no-such-id')
  })
})

describe('the waylines held in memory (FR-WAY-09)', () => {
  it('keeps a wayline as saved, its waypoints the bake gave them, and lists it by name', async () => {
    const backend = new FakeBackend(PILOT)
    const created = await backend.createWayline(NORTH.id, WAYLINE)
    expect(await backend.waylines(NORTH.id)).toEqual([created])
    expect(created).toMatchObject({
      name: 'Ronda',
      defaultHeightM: 40,
      bakeVersion: '1.0.0',
      metrics: WAYLINE.metrics,
    })
    expect(created.waypoints).toEqual(WAYLINE.waypoints)
  })

  it('announces a wayline written and retired on the state topic', async () => {
    const backend = new FakeBackend(PILOT)
    const events = heard(backend, NORTH.id)
    const created = await backend.createWayline(NORTH.id, WAYLINE)
    const renamed = await backend.changeWayline(created.id, { name: 'Ronda alta' })
    await backend.retireWayline(created.id)
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({
      kind: 'wayline',
      payload: { id: created.id, name: 'Ronda', updated_at: created.updatedAt, deleted_at: null },
    })
    expect(events[1]).toEqual({
      kind: 'wayline',
      payload: {
        id: created.id,
        name: 'Ronda alta',
        updated_at: renamed.updatedAt,
        deleted_at: null,
      },
    })
    const retirement = events[2]?.payload
    expect(retirement).toEqual({
      id: created.id,
      name: 'Ronda alta',
      updated_at: retirement?.deleted_at,
      deleted_at: expect.any(String) as unknown,
    })
    expect(await backend.waylines(NORTH.id)).toEqual([])
  })

  it.each([
    ['a blank name', { name: '' }, 'name', 'A wayline needs a name.'],
    [
      'no height above takeoff',
      { defaultHeightM: 0 },
      'defaultHeightM',
      "A wayline's default height must be above zero.",
    ],
    [
      'no baked waypoint',
      { waypoints: [] },
      'waypoints',
      'A wayline needs baked waypoints, each with a position and a height above zero.',
    ],
    [
      'a baked waypoint of no height',
      {
        waypoints: [
          { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 0 },
        ],
      },
      'waypoints',
      'A wayline needs baked waypoints, each with a position and a height above zero.',
    ],
    [
      'a blank bake version',
      { bakeVersion: ' ' },
      'bakeVersion',
      'A wayline needs the version of the bake that produced it.',
    ],
  ] as const)('refuses %s, naming its field', async (_, changes, field, message) => {
    const backend = new FakeBackend(PILOT)
    const refusal = await refusedBy(backend.createWayline(NORTH.id, { ...WAYLINE, ...changes }))
    expect(refusal).toMatchObject({ field, message, code: '23514' })
  })

  it('refuses a viewer to create, and a retired wayline any change', async () => {
    const backend = new FakeBackend(PILOT)
    expect(await refusedBy(backend.createWayline(ORCHARD.id, WAYLINE))).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change waylines.',
    })
    const created = await backend.createWayline(NORTH.id, WAYLINE)
    await backend.retireWayline(created.id)
    expect(await refusedBy(backend.changeWayline(created.id, { name: 'x' }))).toMatchObject({
      message: 'A retired wayline does not change.',
    })
    expect(await refusedBy(backend.retireWayline(created.id))).toMatchObject({
      message: 'A retired wayline does not change.',
    })
  })
})
