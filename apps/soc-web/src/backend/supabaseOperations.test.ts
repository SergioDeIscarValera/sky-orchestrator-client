// @vitest-environment node
import { ADDRESS, EMAIL, FakeSupabase } from '../test/fakeSupabase'
import { jwtFor, PASSWORD_FOR_TESTS } from '../test/keys'
import {
  BackendError,
  FieldRefusedError,
  type AssignmentDraft,
  type Backend,
  type OperationDraft,
} from './backend'
import { supabaseBackend } from './supabase'

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OPERATION_ID = '66666666-6666-4666-8666-666666666666'
const ASSIGNMENT_ID = '77777777-7777-4777-8777-777777777777'
const FLEET_ID = '33333333-3333-4333-8333-333333333333'
const WAYLINE_ID = '55555555-5555-4555-8555-555555555555'
const GEOFENCE_ID = '44444444-4444-4444-8444-444444444444'
const PROFILE_ID = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
const FLIGHT_ID = '88888888-8888-4888-8888-888888888888'
const COMMAND_ID = '99999999-9999-4999-8999-999999999999'
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLIENT_REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EVENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STAMP = '2026-10-11T10:10:00+00:00'

const ENVELOPE = {
  geofence_center: { latitude_deg: 41.6523, longitude_deg: -4.7245 },
  geofence_radius_m: 1000,
  max_height_m: 120,
  max_home_distance_m: 1000,
  max_leg_m: 300,
  max_transit_m: 300,
  max_total_distance_m: 5000,
  max_waypoints: 200,
  max_horizontal_speed_ms: 15,
}

const OPERATION_ROW = {
  id: OPERATION_ID,
  organization_id: ORGANIZATION,
  name: 'North corridor',
  geofence_id: null,
  takeoff_security_height_m: null,
  state: 'draft',
  end_reason: null,
  created_by: PROFILE_ID,
  created_at: STAMP,
  updated_at: STAMP,
  started_at: null,
  ended_at: null,
}

const OPERATION = {
  id: OPERATION_ID,
  organizationId: ORGANIZATION,
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
  state: 'draft',
  endReason: null,
  createdBy: PROFILE_ID,
  createdAt: STAMP,
  updatedAt: STAMP,
  startedAt: null,
  endedAt: null,
}

const DRAFT: OperationDraft = {
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
}

const ASSIGNMENT_ROW = {
  id: ASSIGNMENT_ID,
  operation_id: OPERATION_ID,
  wayline_id: WAYLINE_ID,
  fleet_id: FLEET_ID,
  speed_ms: '12.5',
  flight: { schema_version: '2.2.0', waypoints: [] },
}

const ASSIGNMENT_DRAFT: AssignmentDraft = {
  waylineId: WAYLINE_ID,
  fleetId: FLEET_ID,
  speedMs: 12.5,
  flight: { schema_version: '2.2.0', waypoints: [] },
}

const OPERATOR_ROW = { operation_id: OPERATION_ID, profile_id: PROFILE_ID, role: 'pilot' }

const CHECK_ROW = {
  operation_id: OPERATION_ID,
  organization_id: ORGANIZATION,
  check_id: 'PF-GNSS',
  state: 'pass',
  blocking: true,
  value: { satellites: 14 },
  detail: null,
  evaluated_at: STAMP,
}

const EVENT_ROW = {
  id: EVENT_ID,
  organization_id: ORGANIZATION,
  operation_id: OPERATION_ID,
  flight_id: null,
  fleet_id: null,
  command_id: null,
  occurred_at: STAMP,
  recorded_at: STAMP,
  kind: 'operation_created',
  severity: 'info',
  source: 'operator',
  actor_id: PROFILE_ID,
  payload: { name: 'North corridor' },
}

const REQUEST_ROW = {
  id: REQUEST_ID,
  operation_id: OPERATION_ID,
  transition: 'plan',
  status: 'pending',
  reasons: null,
  requested_by: PROFILE_ID,
  requested_at: STAMP,
  decided_at: null,
}

const FLIGHT_ROW = {
  id: FLIGHT_ID,
  operation_id: OPERATION_ID,
  mode: 'simulated',
  fleet_id: FLEET_ID,
  gateway_sn: 'SOTESTDOCK01',
  aircraft_sn: '1WNBH9E00A0042',
  prepared_at: STAMP,
  executed_at: null,
  took_off_at: null,
  landed_at: null,
  ended_at: null,
  end_reason: null,
}

const COMMAND_ROW = {
  id: COMMAND_ID,
  operation_id: OPERATION_ID,
  flight_id: FLIGHT_ID,
  verb: 'pause',
  status: 'pending',
  result: null,
  requested_by: PROFILE_ID,
  requested_at: STAMP,
  sent_at: null,
  replied_at: null,
}

async function signedIn() {
  const supabase = new FakeSupabase()
  const backend: Backend = supabaseBackend(
    { supabaseUrl: ADDRESS, supabaseKey: jwtFor('anon') },
    { fetch: supabase.fetch, autoRefreshToken: false },
  )
  await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)
  return { backend, supabase }
}

function last(supabase: FakeSupabase) {
  const request = supabase.requests.at(-1)
  if (request === undefined) throw new Error('no request')
  return request
}

describe('the operations through PostgREST (IR-OPS, IR-ASG, IR-OPR)', () => {
  it("reads the organization's operations, newest first, as the rows are", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/operations', { status: 200, body: [OPERATION_ROW] })
    expect(await backend.operations(ORGANIZATION)).toEqual([OPERATION])
    const request = last(supabase)
    expect([
      request.url.searchParams.get('organization_id'),
      request.url.searchParams.get('order'),
    ]).toEqual([`eq.${ORGANIZATION}`, 'created_at.desc'])
    expect(request.headers.get('accept-profile')).toBe('soc')
  })

  it('reads a row with its height and its geofence, the height as a number', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/operations', {
      status: 200,
      body: [{ ...OPERATION_ROW, geofence_id: GEOFENCE_ID, takeoff_security_height_m: '30' }],
    })
    expect(await backend.operations(ORGANIZATION)).toMatchObject([
      { geofenceId: GEOFENCE_ID, takeoffSecurityHeightM: 30 },
    ])
  })

  it('creates an operation with its columns, and gets back a draft', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/operations', { status: 201, body: OPERATION_ROW })
    expect(await backend.createOperation(ORGANIZATION, DRAFT)).toEqual(OPERATION)
    const request = last(supabase)
    expect(request.headers.get('content-profile')).toBe('soc')
    expect(request.body).toEqual({
      organization_id: ORGANIZATION,
      name: 'North corridor',
      geofence_id: null,
      takeoff_security_height_m: null,
    })
  })

  it('changes only the fields given, and refuses a change row security left untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/operations', {
      status: 200,
      body: [{ ...OPERATION_ROW, name: 'Norte alta' }],
    })
    expect(await backend.changeOperation(OPERATION_ID, { name: 'Norte alta' })).toMatchObject({
      name: 'Norte alta',
    })
    expect(last(supabase).body).toEqual({ name: 'Norte alta' })
    expect(last(supabase).url.searchParams.get('id')).toBe(`eq.${OPERATION_ID}`)
    supabase.answers.set('PATCH /rest/v1/operations', { status: 200, body: [] })
    await expect(backend.changeOperation(OPERATION_ID, { name: 'x' })).rejects.toThrow(
      'Nothing changed: this operation is not one your role in this organization can change.',
    )
  })

  it("reads an operation's assignments, the speed as a number and the flight as given", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/assignments', { status: 200, body: [ASSIGNMENT_ROW] })
    expect(await backend.assignments(OPERATION_ID)).toEqual([
      {
        id: ASSIGNMENT_ID,
        operationId: OPERATION_ID,
        waylineId: WAYLINE_ID,
        fleetId: FLEET_ID,
        speedMs: 12.5,
        flight: ASSIGNMENT_ROW.flight,
      },
    ])
    expect(last(supabase).url.searchParams.get('operation_id')).toBe(`eq.${OPERATION_ID}`)
  })

  it('assigns a wayline and a fleet with the flight it flies, and gets back the assignment', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/assignments', { status: 201, body: ASSIGNMENT_ROW })
    await backend.assign(OPERATION_ID, ORGANIZATION, ASSIGNMENT_DRAFT)
    expect(last(supabase).body).toEqual({
      operation_id: OPERATION_ID,
      organization_id: ORGANIZATION,
      wayline_id: WAYLINE_ID,
      fleet_id: FLEET_ID,
      speed_ms: 12.5,
      flight: ASSIGNMENT_DRAFT.flight,
    })
  })

  it('changes an assignment and unassigns it, and refuses either row security left untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/assignments', { status: 200, body: [ASSIGNMENT_ROW] })
    await backend.changeAssignment(ASSIGNMENT_ID, { speedMs: 12.5 })
    expect(last(supabase).body).toEqual({ speed_ms: 12.5 })
    supabase.answers.set('DELETE /rest/v1/assignments', {
      status: 200,
      body: [{ id: ASSIGNMENT_ID }],
    })
    await backend.unassign(ASSIGNMENT_ID)
    expect(last(supabase).url.searchParams.get('id')).toBe(`eq.${ASSIGNMENT_ID}`)
    supabase.answers.set('PATCH /rest/v1/assignments', { status: 200, body: [] })
    supabase.answers.set('DELETE /rest/v1/assignments', { status: 200, body: [] })
    const changed = await backend
      .changeAssignment(ASSIGNMENT_ID, { speedMs: 1 })
      .catch((e: unknown) => e)
    const removed = await backend.unassign(ASSIGNMENT_ID).catch((e: unknown) => e)
    expect(changed).toMatchObject({
      message: expect.stringMatching(/^Nothing changed: this assignment/) as unknown,
    })
    expect(removed).toBeInstanceOf(FieldRefusedError)
  })

  it("reads an operation's operators, names one, changes a role and removes one", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/operators', { status: 200, body: [OPERATOR_ROW] })
    expect(await backend.operators(OPERATION_ID)).toEqual([
      { operationId: OPERATION_ID, profileId: PROFILE_ID, role: 'pilot' },
    ])
    supabase.answers.set('POST /rest/v1/operators', { status: 201, body: OPERATOR_ROW })
    await backend.nameOperator(OPERATION_ID, ORGANIZATION, PROFILE_ID, 'pilot')
    expect(last(supabase).body).toEqual({
      operation_id: OPERATION_ID,
      organization_id: ORGANIZATION,
      profile_id: PROFILE_ID,
      role: 'pilot',
    })
    supabase.answers.set('PATCH /rest/v1/operators', {
      status: 200,
      body: [{ ...OPERATOR_ROW, role: 'observer' }],
    })
    expect(await backend.changeOperator(OPERATION_ID, PROFILE_ID, 'observer')).toEqual({
      operationId: OPERATION_ID,
      profileId: PROFILE_ID,
      role: 'observer',
    })
    supabase.answers.set('DELETE /rest/v1/operators', {
      status: 200,
      body: [{ profile_id: PROFILE_ID }],
    })
    await backend.removeOperator(OPERATION_ID, PROFILE_ID)
    expect(last(supabase).url.searchParams.get('profile_id')).toBe(`eq.${PROFILE_ID}`)
    supabase.answers.set('DELETE /rest/v1/operators', { status: 200, body: [] })
    await expect(backend.removeOperator(OPERATION_ID, PROFILE_ID)).rejects.toThrow(
      'Nothing changed: this operator is not one your role in this organization can change.',
    )
  })

  it("reads the organization's members through soc.organization_members, as the RPC answers them", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/organization_members', {
      status: 200,
      body: [{ profile_id: PROFILE_ID, display_name: null, email: EMAIL, role: 'owner' }],
    })
    expect(await backend.members(ORGANIZATION)).toEqual([
      { profileId: PROFILE_ID, displayName: null, email: EMAIL, role: 'owner' },
    ])
    expect(last(supabase).body).toEqual({ organization: ORGANIZATION })
    expect(last(supabase).headers.get('content-profile')).toBe('soc')
  })

  it('reads the checks, the log oldest first and the requests newest first', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/operation_checks', { status: 200, body: [CHECK_ROW] })
    expect(await backend.checks(OPERATION_ID)).toEqual([
      {
        checkId: 'PF-GNSS',
        state: 'pass',
        blocking: true,
        value: { satellites: 14 },
        detail: null,
        evaluatedAt: STAMP,
      },
    ])
    supabase.answers.set('GET /rest/v1/operation_events', { status: 200, body: [EVENT_ROW] })
    const events = await backend.events(OPERATION_ID)
    expect(events).toMatchObject([{ id: EVENT_ID, kind: 'operation_created', actorId: PROFILE_ID }])
    expect(last(supabase).url.searchParams.get('order')).toBe('recorded_at.asc')
    supabase.answers.set('GET /rest/v1/transition_requests', { status: 200, body: [REQUEST_ROW] })
    expect(await backend.requests(OPERATION_ID)).toEqual([
      {
        id: REQUEST_ID,
        operationId: OPERATION_ID,
        transition: 'plan',
        status: 'pending',
        reasons: null,
        requestedBy: PROFILE_ID,
        requestedAt: STAMP,
        decidedAt: null,
      },
    ])
    expect(last(supabase).url.searchParams.get('order')).toBe('requested_at.desc')
  })

  it('reads the flights, their states through their flights, and the commands; the stacks with their envelope', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/flights', { status: 200, body: [FLIGHT_ROW] })
    expect(await backend.flights(OPERATION_ID)).toEqual([
      {
        id: FLIGHT_ID,
        operationId: OPERATION_ID,
        mode: 'simulated',
        fleetId: FLEET_ID,
        gatewaySn: 'SOTESTDOCK01',
        aircraftSn: '1WNBH9E00A0042',
        preparedAt: STAMP,
        executedAt: null,
        tookOffAt: null,
        landedAt: null,
        endedAt: null,
        endReason: null,
      },
    ])
    supabase.answers.set('GET /rest/v1/flight_states', {
      status: 200,
      body: [
        {
          flight_id: FLIGHT_ID,
          status: 'in_progress',
          result: null,
          percent: 40,
          current_waypoint_index: 2,
          end_reason: null,
          updated_at: STAMP,
          flights: { operation_id: OPERATION_ID },
        },
      ],
    })
    expect(await backend.flightStates(OPERATION_ID)).toEqual([
      {
        flightId: FLIGHT_ID,
        status: 'in_progress',
        result: null,
        percent: 40,
        currentWaypointIndex: 2,
        endReason: null,
        updatedAt: STAMP,
      },
    ])
    expect(last(supabase).url.searchParams.get('flights.operation_id')).toBe(`eq.${OPERATION_ID}`)
    supabase.answers.set('GET /rest/v1/command_intents', { status: 200, body: [COMMAND_ROW] })
    expect(await backend.commands(OPERATION_ID)).toMatchObject([
      { id: COMMAND_ID, verb: 'pause', status: 'pending', flightId: FLIGHT_ID },
    ])
    supabase.answers.set('GET /rest/v1/stacks', {
      status: 200,
      body: [
        {
          gateway_sn: 'SOTESTDOCK01',
          name: 'lab',
          link_state: 'connected',
          envelope: ENVELOPE,
          envelope_read_at: STAMP,
        },
      ],
    })
    expect(await backend.stacks(ORGANIZATION)).toEqual([
      {
        gatewaySn: 'SOTESTDOCK01',
        name: 'lab',
        linkState: 'connected',
        envelope: ENVELOPE,
        envelopeReadAt: STAMP,
      },
    ])
    expect(last(supabase).url.searchParams.get('select')).toBe(
      'gateway_sn,name,link_state,envelope,envelope_read_at',
    )
  })

  it('asks a transition through the RPC, its client request id the key the database keeps', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/request_transition', { status: 200, body: REQUEST_ROW })
    const first = await backend.requestTransition(OPERATION_ID, 'plan', CLIENT_REQUEST)
    const again = await backend.requestTransition(OPERATION_ID, 'plan', CLIENT_REQUEST)
    expect(first).toEqual(again)
    expect(first).toMatchObject({ id: REQUEST_ID, transition: 'plan' })
    const sent = supabase.requests.filter((request) =>
      request.url.pathname.endsWith('/request_transition'),
    )
    expect(sent.map((request) => request.body)).toEqual([
      { operation: OPERATION_ID, wanted: 'plan', client_request: CLIENT_REQUEST },
      { operation: OPERATION_ID, wanted: 'plan', client_request: CLIENT_REQUEST },
    ])
    expect(last(supabase).headers.get('content-profile')).toBe('soc')
  })

  it('asks a command through the RPC, its client request id the key the database keeps', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/request_command', { status: 200, body: COMMAND_ROW })
    expect(await backend.requestCommand(FLIGHT_ID, 'pause', CLIENT_REQUEST)).toMatchObject({
      id: COMMAND_ID,
      verb: 'pause',
    })
    expect(last(supabase).body).toEqual({
      flight: FLIGHT_ID,
      wanted: 'pause',
      client_request: CLIENT_REQUEST,
    })
  })

  it.each([
    [
      'an operation',
      'GET /rest/v1/operations',
      { ...OPERATION_ROW, state: 'drafted' },
      (b: Backend) => b.operations(ORGANIZATION),
    ],
    [
      'a check',
      'GET /rest/v1/operation_checks',
      { ...CHECK_ROW, check_id: 'GNSS' },
      (b: Backend) => b.checks(OPERATION_ID),
    ],
    [
      'a log entry',
      'GET /rest/v1/operation_events',
      { ...EVENT_ROW, severity: 'unknown' },
      (b: Backend) => b.events(OPERATION_ID),
    ],
    [
      'a request',
      'GET /rest/v1/transition_requests',
      { ...REQUEST_ROW, reasons: [1] },
      (b: Backend) => b.requests(OPERATION_ID),
    ],
    [
      'a stack',
      'GET /rest/v1/stacks',
      {
        gateway_sn: 'SOTESTDOCK01',
        name: 'lab',
        link_state: 'connected',
        envelope: [1],
        envelope_read_at: null,
      },
      (b: Backend) => b.stacks(ORGANIZATION),
    ],
  ])('refuses %s it cannot read, rather than showing a guess', async (_label, route, row, read) => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set(route, { status: 200, body: [row] })
    await expect(read(backend)).rejects.toThrow(BackendError)
  })

  it('refuses an answer to the RPC it cannot read', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/request_transition', {
      status: 200,
      body: { ...REQUEST_ROW, status: 'queued' },
    })
    await expect(backend.requestTransition(OPERATION_ID, 'plan', CLIENT_REQUEST)).rejects.toThrow(
      'soc.transition_requests answered rows SOC cannot read',
    )
  })

  it('passes on a failure it does not name as a plain error', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/operations', {
      status: 500,
      body: { code: 'XX000', message: 'the database is busy', details: null, hint: null },
    })
    const failure = await backend.operations(ORGANIZATION).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect(failure).not.toBeInstanceOf(FieldRefusedError)
    expect(failure).toMatchObject({ message: 'the database is busy', code: 'XX000' })
  })
})

describe('the refusals the database makes of an operation (migration 0010)', () => {
  // Each route answers the database's words; the call is the write that sends it.
  const CALLS: Record<string, (backend: Backend) => Promise<unknown>> = {
    'POST /rest/v1/operations': (backend) => backend.createOperation(ORGANIZATION, DRAFT),
    'PATCH /rest/v1/operations': (backend) =>
      backend.changeOperation(OPERATION_ID, { takeoffSecurityHeightM: 40 }),
    'POST /rest/v1/assignments': (backend) =>
      backend.assign(OPERATION_ID, ORGANIZATION, ASSIGNMENT_DRAFT),
    'PATCH /rest/v1/assignments': (backend) =>
      backend.changeAssignment(ASSIGNMENT_ID, { speedMs: 0 }),
    'POST /rest/v1/operators': (backend) =>
      backend.nameOperator(OPERATION_ID, ORGANIZATION, PROFILE_ID, 'pilot'),
    'POST /rest/v1/rpc/request_command': (backend) =>
      backend.requestCommand(FLIGHT_ID, 'pause', CLIENT_REQUEST),
  }

  it.each([
    [
      'POST /rest/v1/operations',
      400,
      '23514',
      'new row for relation "operations" violates check constraint "operation_name_given"',
      'name',
      'An operation needs a name.',
    ],
    [
      'PATCH /rest/v1/operations',
      400,
      '23514',
      'new row for relation "operations" violates check constraint "operation_height_positive"',
      'takeoffSecurityHeightM',
      'The takeoff security height must be above zero.',
    ],
    [
      'POST /rest/v1/operations',
      400,
      '23503',
      'insert or update on table "operations" violates foreign key constraint "operations_geofence_id_organization_id_fkey"',
      'geofenceId',
      "This geofence is not one of the organization's.",
    ],
    [
      'POST /rest/v1/assignments',
      400,
      '23514',
      'new row for relation "assignments" violates check constraint "assignment_speed_positive"',
      'speedMs',
      'The speed the fleet flies the wayline at must be above zero.',
    ],
    [
      'POST /rest/v1/assignments',
      400,
      '23514',
      'new row for relation "assignments" violates check constraint "assignment_flight_object"',
      'flight',
      'The wayline as the operation flies it must be an object.',
    ],
    [
      'POST /rest/v1/assignments',
      409,
      '23505',
      'duplicate key value violates unique constraint "assignment_wayline_once"',
      'waylineId',
      'The operation already flies this wayline.',
    ],
    [
      'POST /rest/v1/assignments',
      409,
      '23505',
      'duplicate key value violates unique constraint "assignment_fleet_once"',
      'fleetId',
      'The operation already flies with this fleet.',
    ],
    [
      'POST /rest/v1/assignments',
      400,
      '23503',
      'insert or update on table "assignments" violates foreign key constraint "assignments_wayline_id_organization_id_fkey"',
      'waylineId',
      "This wayline is not one of the organization's.",
    ],
    [
      'POST /rest/v1/assignments',
      400,
      '23503',
      'insert or update on table "assignments" violates foreign key constraint "assignments_fleet_id_organization_id_fkey"',
      'fleetId',
      "This fleet is not one of the organization's.",
    ],
    [
      'POST /rest/v1/assignments',
      400,
      '23514',
      `operation ${OPERATION_ID}: one assignment in the MVP`,
      null,
      'An operation flies one wayline with one fleet in the MVP.',
    ],
    [
      'PATCH /rest/v1/operations',
      400,
      '23514',
      `operation ${OPERATION_ID}: its definition is fixed once it is simulating`,
      null,
      "The operation's definition is fixed from simulating on, and its operators from launching on.",
    ],
    [
      'PATCH /rest/v1/operations',
      400,
      '23514',
      `operation ${OPERATION_ID}: closed when it became completed`,
      null,
      'This operation has ended, and does not change.',
    ],
    [
      'PATCH /rest/v1/assignments',
      400,
      '23514',
      `operation ${OPERATION_ID}: its definition is fixed once it is simulating`,
      null,
      "The operation's definition is fixed from simulating on, and its operators from launching on.",
    ],
    [
      'POST /rest/v1/operators',
      400,
      '23514',
      `operation ${OPERATION_ID}: its operators are fixed once it is launching`,
      null,
      "The operation's definition is fixed from simulating on, and its operators from launching on.",
    ],
    [
      'POST /rest/v1/operators',
      400,
      '23503',
      'insert or update on table "operators" violates foreign key constraint "operators_organization_id_profile_id_fkey"',
      'profileId',
      'Only a member of the organization can be named an operator.',
    ],
    [
      'POST /rest/v1/operators',
      409,
      '23505',
      'duplicate key value violates unique constraint "operators_pkey"',
      'profileId',
      'This member is already an operator of the operation.',
    ],
    [
      'POST /rest/v1/rpc/request_command',
      400,
      '23514',
      `flight ${FLIGHT_ID}: it has ended`,
      null,
      'This flight has ended: its aircraft takes no more commands.',
    ],
  ])(
    'names what the database refused (%s, %s, %s)',
    async (route, status, code, message, field, text) => {
      const { backend, supabase } = await signedIn()
      supabase.answers.set(route, { status, body: { code, message, details: null, hint: null } })
      const refusal = await CALLS[route]?.(backend).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(FieldRefusedError)
      expect(refusal).toMatchObject({ field, message: text, code })
    },
  )

  it('says a viewer may not create or change an operation, the insert refused by row security', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/operations', {
      status: 403,
      body: {
        code: '42501',
        message: 'new row violates row-level security policy for table "operations"',
        details: null,
        hint: null,
      },
    })
    expect(
      await backend.createOperation(ORGANIZATION, DRAFT).catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change operations.',
    })
  })

  it('says a viewer or an observer may not ask an operation to move, through the RPC', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/request_transition', {
      status: 403,
      body: {
        code: '42501',
        message: `operation ${OPERATION_ID}: an editor of its organization asks it to move`,
        details: null,
        hint: null,
      },
    })
    expect(
      await backend
        .requestTransition(OPERATION_ID, 'plan', CLIENT_REQUEST)
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners ask an operation to move.',
    })
    supabase.answers.set('POST /rest/v1/rpc/request_transition', {
      status: 403,
      body: {
        code: '42501',
        message: `operation ${OPERATION_ID}: only its pilots simulate`,
        details: null,
        hint: null,
      },
    })
    expect(
      await backend
        .requestTransition(OPERATION_ID, 'simulate', CLIENT_REQUEST)
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      message: 'Only a pilot of the operation asks it to simulate, launch or stop.',
    })
  })

  it('says an observer may not command a flight, the function refusing a pilot only', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/rpc/request_command', {
      status: 403,
      body: {
        code: '42501',
        message: `flight ${FLIGHT_ID}: only a pilot of its operation commands it`,
        details: null,
        hint: null,
      },
    })
    expect(
      await backend
        .requestCommand(FLIGHT_ID, 'pause', CLIENT_REQUEST)
        .catch((error: unknown) => error),
    ).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only a pilot of the operation commands its aircraft.',
    })
  })

  it('says a viewer changes no operator: row security leaves it untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/operators', { status: 200, body: [] })
    expect(
      await backend
        .changeOperator(OPERATION_ID, PROFILE_ID, 'observer')
        .catch((error: unknown) => error),
    ).toMatchObject({
      message:
        'Nothing changed: this operator is not one your role in this organization can change.',
    })
  })
})
