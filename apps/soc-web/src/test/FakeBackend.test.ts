import {
  BackendError,
  FieldRefusedError,
  type AssignmentDraft,
  type FleetDraft,
  type Flight,
  type GeofenceDraft,
  type OperationCheck,
  type OperationDraft,
  type StateEvent,
  type WaylineDraft,
} from '../backend/backend'
import { FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH, ORCHARD, PILOT } from './FakeBackend'
import { PASSWORD_FOR_TESTS } from './keys'

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

const OPERATION_DRAFT: OperationDraft = {
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
}

const FLEET: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 0,
}

const CHECK: OperationCheck = {
  checkId: 'PF-GNSS',
  state: 'pass',
  blocking: true,
  value: { satellites: 14 },
  detail: null,
  evaluatedAt: '2026-10-11T10:10:00Z',
}

const STAMP = '2026-10-11T10:10:00Z'
const CLIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FLIGHT = '88888888-8888-4888-8888-888888888888'
const OTHER_FLIGHT = '88888888-8888-4888-8888-888888888889'

function flightOf(operationId: string, fleetId: string, id = FLIGHT): Flight {
  return {
    id,
    operationId,
    mode: 'simulated',
    fleetId,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: STAMP,
    executedAt: null,
    tookOffAt: null,
    landedAt: null,
    endedAt: null,
    endReason: null,
    breachedAt: null,
  }
}

/** A pilot's north organization with a wayline and a fleet to fly, and an operation to fly them. */
async function prepared() {
  const backend = new FakeBackend(PILOT)
  const operation = await backend.createOperation(NORTH.id, OPERATION_DRAFT)
  const wayline = await backend.createWayline(NORTH.id, WAYLINE)
  const fleet = await backend.registerFleet(NORTH.id, FLEET)
  const draft: AssignmentDraft = {
    waylineId: wayline.id,
    fleetId: fleet.id,
    speedMs: 10,
    flight: null,
  }
  return { backend, operation, fleet, draft }
}

describe('the operations held in memory (IR-OPS, IR-ASG, IR-OPR, IR-TRQ, IR-CMD)', () => {
  it('makes a new operation a draft, made by the signed-in member, and logs its creation', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, OPERATION_DRAFT)
    expect(operation).toMatchObject({
      state: 'draft',
      createdBy: PILOT.userId,
      endReason: null,
      endedAt: null,
    })
    expect(await backend.operations(NORTH.id)).toEqual([operation])
    expect(await backend.events(operation.id)).toMatchObject([
      { kind: 'operation_created', source: 'operator', payload: { name: 'North corridor' } },
    ])
  })

  it('announces a new operation and its log entry on the state topic, as the database broadcasts them', async () => {
    const backend = new FakeBackend(PILOT)
    const seen: StateEvent[] = []
    backend.onState(NORTH.id, (event) => seen.push(event))
    const operation = await backend.createOperation(NORTH.id, OPERATION_DRAFT)
    expect(seen.map(({ kind }) => kind).sort()).toEqual(['operation', 'operation_event'])
    expect(seen.find(({ kind }) => kind === 'operation')?.payload).toMatchObject({
      id: operation.id,
      state: 'draft',
    })
    expect(seen.find(({ kind }) => kind === 'operation_event')?.payload).toMatchObject({
      operation_id: operation.id,
      kind: 'operation_created',
    })
  })

  it('refuses a name, a height or a geofence the database would refuse, and a viewer', async () => {
    const backend = new FakeBackend(PILOT)
    const refused = (draft: OperationDraft, organizationId = NORTH.id) =>
      backend.createOperation(organizationId, draft).catch((error: unknown) => error)
    expect(await refused({ ...OPERATION_DRAFT, name: ' ' })).toMatchObject({
      field: 'name',
      code: '23514',
    })
    expect(await refused({ ...OPERATION_DRAFT, takeoffSecurityHeightM: 0 })).toMatchObject({
      field: 'takeoffSecurityHeightM',
    })
    expect(
      await refused({ ...OPERATION_DRAFT, geofenceId: '44444444-4444-4444-8444-444444444444' }),
    ).toMatchObject({ field: 'geofenceId', code: '23503' })
    expect(await refused(OPERATION_DRAFT, ORCHARD.id)).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change operations.',
    })
  })

  it('holds one assignment per operation in the MVP, and refuses a second', async () => {
    const { backend, operation, draft } = await prepared()
    await backend.assign(operation.id, NORTH.id, draft)
    expect(await backend.assignments(operation.id)).toHaveLength(1)
    expect(
      await backend.assign(operation.id, NORTH.id, draft).catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '23514',
      message: 'An operation flies one wayline with one fleet in the MVP.',
    })
  })

  it('checks what an assignment names: a positive speed, a wayline and a fleet of the organization', async () => {
    const { backend, operation, draft } = await prepared()
    const refused = (changes: AssignmentDraft) =>
      backend.assign(operation.id, NORTH.id, changes).catch((error: unknown) => error)
    expect(await refused({ ...draft, speedMs: 0 })).toMatchObject({
      field: 'speedMs',
      code: '23514',
    })
    expect(
      await refused({ ...draft, waylineId: '55555555-5555-4555-8555-555555555556' }),
    ).toMatchObject({ field: 'waylineId', code: '23503' })
    expect(
      await refused({ ...draft, fleetId: '33333333-3333-4333-8333-333333333334' }),
    ).toMatchObject({ field: 'fleetId', code: '23503' })
  })

  it('fixes the definition from simulating on: the geofence, the height and the assignment', async () => {
    const { backend, operation, draft } = await prepared()
    const assignment = await backend.assign(operation.id, NORTH.id, draft)
    backend.moveOperation(operation.id, 'planned')
    backend.moveOperation(operation.id, 'preparing')
    backend.moveOperation(operation.id, 'simulating')
    expect(
      await backend
        .changeOperation(operation.id, { takeoffSecurityHeightM: 30 })
        .catch((error: unknown) => error),
    ).toMatchObject({ field: null, code: '23514' })
    expect(
      await backend
        .changeAssignment(assignment.id, { speedMs: 5 })
        .catch((error: unknown) => error),
    ).toMatchObject({ field: null, code: '23514' })
    expect(await backend.unassign(assignment.id).catch((error: unknown) => error)).toMatchObject({
      code: '23514',
    })
    expect(await backend.changeOperation(operation.id, { name: 'Norte alta' })).toMatchObject({
      name: 'Norte alta',
      state: 'simulating',
    })
  })

  it('plans a preparing operation again when its assignment changes, and logs why', async () => {
    const { backend, operation, draft } = await prepared()
    const assignment = await backend.assign(operation.id, NORTH.id, draft)
    backend.moveOperation(operation.id, 'planned')
    backend.moveOperation(operation.id, 'preparing')
    await backend.changeAssignment(assignment.id, { speedMs: 8 })
    expect(await backend.operations(NORTH.id)).toMatchObject([{ state: 'planned' }])
    expect(await backend.events(operation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'operation_definition_changed',
          payload: { what: 'assignment' },
        }),
        expect.objectContaining({
          kind: 'operation_state_changed',
          payload: expect.objectContaining({
            to: 'planned',
            cause: 'assignment_changed',
          }) as unknown,
        }),
      ]),
    )
  })

  it('closes an operation that has ended: nothing changes, not even its name', async () => {
    const { backend, operation } = await prepared()
    backend.moveOperation(operation.id, 'cancelled')
    expect(
      await backend
        .changeOperation(operation.id, { name: 'Norte' })
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '23514',
      message: 'This operation has ended, and does not change.',
    })
    expect(await backend.operations(NORTH.id)).toMatchObject([
      { state: 'cancelled', endReason: 'cancelled' },
    ])
  })

  it('fixes the operators from launching on, and names none after it', async () => {
    const { backend, operation } = await prepared()
    const path = ['planned', 'preparing', 'simulating', 'simulated', 'ready', 'launching'] as const
    for (const to of path) backend.moveOperation(operation.id, to)
    expect(
      await backend
        .nameOperator(operation.id, NORTH.id, NEIGHBOUR.userId, 'observer')
        .catch((error: unknown) => error),
    ).toMatchObject({ field: null, code: '23514' })
  })

  it('names an operator only from the organization, once', async () => {
    const { backend, operation } = await prepared()
    await backend.nameOperator(operation.id, NORTH.id, PILOT.userId, 'pilot')
    expect(
      await backend
        .nameOperator(operation.id, NORTH.id, PILOT.userId, 'pilot')
        .catch((error: unknown) => error),
    ).toMatchObject({ field: 'profileId', code: '23505' })
    expect(
      await backend
        .nameOperator(operation.id, NORTH.id, 'user-stranger', 'observer')
        .catch((error: unknown) => error),
    ).toMatchObject({ field: 'profileId', code: '23503' })
    expect(await backend.members(NORTH.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: PILOT.userId, role: 'owner', email: PILOT.email }),
      ]),
    )
  })

  it('asks a transition once per client request id, and simulate, launch and stop need a pilot', async () => {
    const { backend, operation } = await prepared()
    const plan = await backend.requestTransition(operation.id, 'plan', CLIENT)
    expect(await backend.requestTransition(operation.id, 'plan', CLIENT)).toEqual(plan)
    expect(await backend.requests(operation.id)).toEqual([plan])
    expect(plan).toMatchObject({ status: 'pending', transition: 'plan', requestedBy: PILOT.userId })
    expect(
      await backend
        .requestTransition(operation.id, 'simulate', OTHER_CLIENT)
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only a pilot of the operation asks it to simulate, launch or stop.',
    })
    await backend.nameOperator(operation.id, NORTH.id, PILOT.userId, 'pilot')
    expect(await backend.requestTransition(operation.id, 'simulate', OTHER_CLIENT)).toMatchObject({
      transition: 'simulate',
    })
    expect(await backend.events(operation.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'transition_requested' })]),
    )
  })

  it('refuses an observer a pilot transition, though the observer may plan', async () => {
    const { backend, operation } = await prepared()
    await backend.nameOperator(operation.id, NORTH.id, NEIGHBOUR.userId, 'observer')
    await backend.signIn(NEIGHBOUR.email, PASSWORD_FOR_TESTS)
    expect(
      await backend
        .requestTransition(operation.id, 'launch', CLIENT)
        .catch((error: unknown) => error),
    ).toMatchObject({ field: null, code: '42501' })
    expect(await backend.requestTransition(operation.id, 'plan', OTHER_CLIENT)).toMatchObject({
      transition: 'plan',
    })
  })

  it('asks a command once per client request id, and refuses it once its flight has ended', async () => {
    const { backend, operation, fleet } = await prepared()
    await backend.nameOperator(operation.id, NORTH.id, PILOT.userId, 'pilot')
    backend.addFlight(flightOf(operation.id, fleet.id))
    const intent = await backend.requestCommand(FLIGHT, 'pause', CLIENT)
    expect(await backend.requestCommand(FLIGHT, 'pause', CLIENT)).toEqual(intent)
    expect(await backend.commands(operation.id)).toEqual([intent])
    backend.addFlight({
      ...flightOf(operation.id, fleet.id, OTHER_FLIGHT),
      endedAt: '2026-10-11T10:20:00Z',
      endReason: 'completed',
    })
    expect(
      await backend.requestCommand(OTHER_FLIGHT, 'undo', CLIENT).catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '23514',
      message: 'This flight has ended: its aircraft takes no more commands.',
    })
  })

  it('undoes only a flight that does not execute yet', async () => {
    const { backend, operation, fleet } = await prepared()
    await backend.nameOperator(operation.id, NORTH.id, PILOT.userId, 'pilot')
    backend.addFlight({ ...flightOf(operation.id, fleet.id), executedAt: '2026-10-11T10:10:00Z' })
    expect(
      await backend.requestCommand(FLIGHT, 'undo', CLIENT).catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '23514',
      message: 'This flight already executes: an undo cancels only one not started yet.',
    })
    expect(await backend.requestCommand(FLIGHT, 'pause', OTHER_CLIENT)).toMatchObject({
      verb: 'pause',
    })
  })

  it('refuses a command to a flight a pilot does not fly', async () => {
    const { backend, operation, fleet } = await prepared()
    backend.addFlight(flightOf(operation.id, fleet.id))
    expect(
      await backend.requestCommand(FLIGHT, 'pause', CLIENT).catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only a pilot of the operation commands its aircraft.',
    })
  })

  it('moves an operation only as the lifecycle allows', async () => {
    const { backend, operation } = await prepared()
    expect(() => backend.moveOperation(operation.id, 'launching')).toThrow(BackendError)
    expect(backend.moveOperation(operation.id, 'planned')).toMatchObject({ state: 'planned' })
  })

  it('starts the record at a launch from ready, never at a launch in the simulator (FR-OPS-13)', async () => {
    const { backend, operation } = await prepared()
    for (const state of ['planned', 'preparing', 'simulating', 'simulated'] as const) {
      backend.moveOperation(operation.id, state)
    }
    for (const state of ['launching', 'in_flight', 'returning', 'simulated'] as const) {
      expect(backend.moveOperation(operation.id, state)).toMatchObject({ state, startedAt: null })
    }
    backend.moveOperation(operation.id, 'launching')
    expect(backend.moveOperation(operation.id, 'simulated')).toMatchObject({ startedAt: null })
    backend.moveOperation(operation.id, 'ready')
    expect(backend.moveOperation(operation.id, 'launching').startedAt).not.toBeNull()
  })

  it('replaces a check by its id, and announces it with the operation it judges', async () => {
    const { backend, operation } = await prepared()
    const seen: StateEvent[] = []
    backend.onState(NORTH.id, (event) => seen.push(event))
    backend.addCheck(operation.id, CHECK)
    backend.addCheck(operation.id, { ...CHECK, state: 'fail', detail: 'Nine satellites.' })
    expect(await backend.checks(operation.id)).toEqual([
      { ...CHECK, state: 'fail', detail: 'Nine satellites.' },
    ])
    expect(seen.at(-1)).toMatchObject({
      kind: 'operation_check',
      payload: { operation_id: operation.id, check_id: 'PF-GNSS', state: 'fail' },
    })
  })

  it('settles a transition request with its reasons, and logs a refusal as a warning', async () => {
    const { backend, operation } = await prepared()
    const request = await backend.requestTransition(operation.id, 'plan', CLIENT)
    backend.settleRequest(request.id, 'running')
    const refused = backend.settleRequest(request.id, 'refused', [
      'PF-GNSS: fewer than twelve satellites',
    ])
    expect(refused).toMatchObject({
      status: 'refused',
      reasons: ['PF-GNSS: fewer than twelve satellites'],
    })
    expect(refused.decidedAt).not.toBeNull()
    expect(await backend.events(operation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'transition_refused',
          severity: 'warning',
          source: 'soc-operations',
        }),
      ]),
    )
    expect(() => backend.settleRequest(request.id, 'accepted')).toThrow(BackendError)
  })

  it('lists the flights, their states, the stacks and the members of the organization', async () => {
    const { backend, operation, fleet } = await prepared()
    const flight = flightOf(operation.id, fleet.id)
    backend.addFlight(flight)
    backend.setFlightState({
      flightId: flight.id,
      status: 'in_progress',
      result: null,
      percent: 40,
      currentWaypointIndex: 2,
      endReason: null,
      updatedAt: STAMP,
    })
    expect(await backend.flights(operation.id)).toEqual([flight])
    expect(await backend.flightStates(operation.id)).toMatchObject([
      { flightId: flight.id, percent: 40 },
    ])
    backend.stacksOf.set(NORTH.id, [
      {
        gatewaySn: 'SOTESTDOCK01',
        name: 'lab',
        linkState: 'connected',
        envelope: { max_height_m: 120 },
        envelopeReadAt: STAMP,
        simulatorMode: true,
      },
    ])
    expect(await backend.stacks(NORTH.id)).toMatchObject([
      { name: 'lab', envelope: { max_height_m: 120 } },
    ])
    expect((await backend.members(NORTH.id)).map(({ profileId }) => profileId)).toEqual(
      expect.arrayContaining([PILOT.userId, NEIGHBOUR.userId]),
    )
  })

  it("keeps a flight's track in time order, and holds none for a flight it does not know", async () => {
    const { backend, operation, fleet } = await prepared()
    const flight = flightOf(operation.id, fleet.id)
    backend.addFlight(flight)
    const point = (second: number) => ({
      sampledAt: `2026-10-11T10:10:0${String(second)}Z`,
      position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
      heightM: second,
    })
    backend.addTrackPoints(flight.id, [point(2), point(0)])
    backend.addTrackPoints(flight.id, [point(1)])
    expect((await backend.track(flight.id)).map(({ heightM }) => heightM)).toEqual([0, 1, 2])
    expect(await backend.track('no-such-flight')).toEqual([])
    expect(() => {
      backend.addTrackPoints('no-such-flight', [point(0)])
    }).toThrow(BackendError)
  })
})

describe("a fleet's wire identity while its aircraft flies (migration 0010, FR-FLE-05)", () => {
  it('refuses the gateway or the aircraft serial to move while a flight is unended, and names no field', async () => {
    const { backend, operation, fleet } = await prepared()
    backend.addFlight(flightOf(operation.id, fleet.id))
    expect(
      await backend
        .changeFleet(fleet.id, { aircraftSn: 'SOTESTUAV002' })
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '23514',
      message: 'This aircraft is flying: its wire identity stays until its flight ends.',
    })
    expect(await backend.changeFleet(fleet.id, { name: 'Norte alta' })).toMatchObject({
      name: 'Norte alta',
      aircraftSn: 'SOTESTUAV001',
    })
  })
})

describe("a flight's breach time on the state topic (FR-SAF-01)", () => {
  it('announces a flight with the time of its geofence breach, as the database broadcasts it', async () => {
    const { backend, operation, fleet } = await prepared()
    const seen: StateEvent[] = []
    backend.onState(NORTH.id, (event) => seen.push(event))
    backend.addFlight({ ...flightOf(operation.id, fleet.id), breachedAt: STAMP })
    expect(seen.at(-1)).toMatchObject({
      kind: 'flight',
      payload: { id: FLIGHT, operation_id: operation.id, breached_at: STAMP },
    })
    expect(await backend.flights(operation.id)).toMatchObject([{ id: FLIGHT, breachedAt: STAMP }])
  })
})
