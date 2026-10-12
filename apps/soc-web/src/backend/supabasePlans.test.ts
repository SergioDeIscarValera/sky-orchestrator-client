// @vitest-environment node
import { ADDRESS, EMAIL, FakeSupabase } from '../test/fakeSupabase'
import { jwtFor, PASSWORD_FOR_TESTS } from '../test/keys'
import {
  BackendError,
  FieldRefusedError,
  type Backend,
  type GeofenceDraft,
  type WaylineDraft,
} from './backend'
import { supabaseBackend } from './supabase'

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const GEOFENCE_ID = '44444444-4444-4444-8444-444444444444'
const WAYLINE_ID = '55555555-5555-4555-8555-555555555555'
const STAMP = '2026-10-11T10:10:00+00:00'

const GEOFENCE_ROW = {
  id: GEOFENCE_ID,
  organization_id: ORGANIZATION,
  name: 'Norte',
  polygon: [
    [-4.7245, 41.6523],
    [-4.71, 41.6523],
    [-4.71, 41.64],
  ],
  max_height_m: 120,
  origin: 'drawn',
  margin_m: null,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
}

const GEOFENCE_DRAFT: GeofenceDraft = {
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

const WAYLINE_ROW = {
  id: WAYLINE_ID,
  organization_id: ORGANIZATION,
  name: 'Ronda',
  takeoff: [-4.7245, 41.6523],
  default_height_m: 40,
  speed_ms: 5,
  design: { schema_version: '1.0.0', primitives: [] },
  waypoints: [
    { index: 0, position: [-4.7245, 41.6523], height_m: 40, actions: [] },
    { index: 1, position: [-4.71, 41.64], height_m: 45, speed_ms: 4 },
  ],
  metrics: { waypoint_count: 2, distance_m: 1234.5, duration_s: 300 },
  bake_version: '1.0.0',
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
}

const WAYLINE_DRAFT: WaylineDraft = {
  name: 'Ronda',
  takeoff: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
  defaultHeightM: 40,
  speedMs: 5,
  design: { schema_version: '1.0.0', primitives: [] },
  waypoints: [
    { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 40 },
    { index: 1, position: { latitudeDeg: 41.64, longitudeDeg: -4.71 }, heightM: 45, speedMs: 4 },
  ],
  metrics: { waypointCount: 2, distanceM: 1234.5, durationS: 300 },
  bakeVersion: '1.0.0',
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

describe('the geofences through PostgREST (IR-GEO, FR-GEO-02)', () => {
  it("reads the organization's live geofences in name order, their ring as positions", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/geofences', { status: 200, body: [GEOFENCE_ROW] })
    expect(await backend.geofences(ORGANIZATION)).toEqual([
      {
        id: GEOFENCE_ID,
        name: 'Norte',
        polygon: GEOFENCE_DRAFT.polygon,
        maxHeightM: 120,
        origin: 'drawn',
        marginM: null,
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ])
    const request = last(supabase)
    const query = request.url.searchParams
    expect([query.get('organization_id'), query.get('deleted_at'), query.get('order')]).toEqual([
      `eq.${ORGANIZATION}`,
      'is.null',
      'name.asc',
    ])
    expect(query.get('select')).toBe('*')
    expect(request.headers.get('accept-profile')).toBe('soc')
  })

  it('creates a geofence with its columns, and gets it back', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/geofences', { status: 201, body: GEOFENCE_ROW })
    expect(await backend.createGeofence(ORGANIZATION, GEOFENCE_DRAFT)).toMatchObject({
      id: GEOFENCE_ID,
      polygon: GEOFENCE_DRAFT.polygon,
    })
    const request = last(supabase)
    expect(request.headers.get('content-profile')).toBe('soc')
    expect(request.body).toEqual({
      organization_id: ORGANIZATION,
      name: 'Norte',
      polygon: [
        [-4.7245, 41.6523],
        [-4.71, 41.6523],
        [-4.71, 41.64],
      ],
      max_height_m: 120,
      origin: 'drawn',
      margin_m: null,
    })
  })

  it('writes a generated geofence with its margin', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/geofences', {
      status: 201,
      body: { ...GEOFENCE_ROW, origin: 'generated', margin_m: '25' },
    })
    const generated = await backend.createGeofence(ORGANIZATION, {
      ...GEOFENCE_DRAFT,
      origin: 'generated',
      marginM: 25,
    })
    expect(generated).toMatchObject({ origin: 'generated', marginM: 25 })
    expect(last(supabase).body).toMatchObject({ origin: 'generated', margin_m: 25 })
  })

  it('changes only the fields given, a ring converted position by position', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/geofences', { status: 200, body: [GEOFENCE_ROW] })
    await backend.changeGeofence(GEOFENCE_ID, { name: 'Norte Alfa' })
    expect(last(supabase).body).toEqual({ name: 'Norte Alfa' })
    expect(last(supabase).url.searchParams.get('id')).toBe(`eq.${GEOFENCE_ID}`)
    await backend.changeGeofence(GEOFENCE_ID, { polygon: GEOFENCE_DRAFT.polygon, marginM: null })
    expect(last(supabase).body).toEqual({
      polygon: [
        [-4.7245, 41.6523],
        [-4.71, 41.6523],
        [-4.71, 41.64],
      ],
      margin_m: null,
    })
  })

  it('retires by a timestamp the database sets, and reads back only its id', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/geofences', { status: 200, body: [{ id: GEOFENCE_ID }] })
    await backend.retireGeofence(GEOFENCE_ID)
    expect(Object.keys(last(supabase).body as object)).toEqual(['deleted_at'])
    expect(last(supabase).url.searchParams.get('select')).toBe('id')
  })

  it('refuses a position it cannot write before it sends anything', async () => {
    const { backend, supabase } = await signedIn()
    const sent = supabase.requests.length
    const refused = await backend
      .createGeofence(ORGANIZATION, {
        ...GEOFENCE_DRAFT,
        polygon: [...GEOFENCE_DRAFT.polygon, { latitudeDeg: Number.NaN, longitudeDeg: -4.7 }],
      })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BackendError)
    expect(refused).not.toBeInstanceOf(FieldRefusedError)
    expect(supabase.requests).toHaveLength(sent)
  })

  it('refuses a stored ring it cannot read, rather than showing a guess', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/geofences', {
      status: 200,
      body: [
        {
          ...GEOFENCE_ROW,
          polygon: [
            [-4.7245, 41.6523],
            [-4.71, 41.6523],
          ],
        },
      ],
    })
    await expect(backend.geofences(ORGANIZATION)).rejects.toThrow(
      'soc.geofences answered rows SOC cannot read',
    )
    supabase.answers.set('GET /rest/v1/geofences', {
      status: 200,
      body: [
        {
          ...GEOFENCE_ROW,
          polygon: [
            [-4.7245, 91],
            [-4.71, 41.6523],
            [-4.71, 41.64],
          ],
        },
      ],
    })
    await expect(backend.geofences(ORGANIZATION)).rejects.toThrow(BackendError)
  })

  it.each([
    [
      400,
      '23514',
      'new row for relation "geofences" violates check constraint "geofence_name_given"',
      'name',
      'A geofence needs a name.',
    ],
    [
      400,
      '23514',
      'new row for relation "geofences" violates check constraint "geofence_polygon_ring"',
      'polygon',
      'A geofence needs a polygon of at least three positions, its last not repeating its first.',
    ],
    [
      400,
      '23514',
      'new row for relation "geofences" violates check constraint "geofence_max_height_positive"',
      'maxHeightM',
      "A geofence's maximum height must be above zero.",
    ],
    [
      400,
      '23514',
      'new row for relation "geofences" violates check constraint "geofence_margin_when_generated"',
      'marginM',
      'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
    ],
  ])(
    'names the field the database refused (%s %s, %s)',
    async (status, code, message, field, text) => {
      const { backend, supabase } = await signedIn()
      supabase.answers.set('POST /rest/v1/geofences', {
        status,
        body: { code, message, details: null, hint: null },
      })
      const refusal = await backend
        .createGeofence(ORGANIZATION, GEOFENCE_DRAFT)
        .catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(FieldRefusedError)
      expect(refusal).toMatchObject({ field, message: text, code })
    },
  )

  it('names the margin refused by a change, as the constraint does', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/geofences', {
      status: 400,
      body: {
        code: '23514',
        message:
          'new row for relation "geofences" violates check constraint "geofence_margin_when_generated"',
        details: null,
        hint: null,
      },
    })
    const refusal = await backend
      .changeGeofence(GEOFENCE_ID, { origin: 'drawn' })
      .catch((error: unknown) => error)
    expect(refusal).toMatchObject({ field: 'marginM' })
  })

  it('says a viewer may not create a geofence, the insert refused by row security', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/geofences', {
      status: 403,
      body: {
        code: '42501',
        message: 'new row violates row-level security policy for table "geofences"',
        details: null,
        hint: null,
      },
    })
    const refusal = await backend
      .createGeofence(ORGANIZATION, GEOFENCE_DRAFT)
      .catch((error: unknown) => error)
    expect(refusal).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change geofences.',
    })
  })

  it('refuses a change or a retirement that row security left untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/geofences', { status: 200, body: [] })
    const changed = await backend
      .changeGeofence(GEOFENCE_ID, { name: 'Norte Alfa' })
      .catch((error: unknown) => error)
    const retired = await backend.retireGeofence(GEOFENCE_ID).catch((error: unknown) => error)
    for (const refused of [changed, retired]) {
      expect(refused).toBeInstanceOf(FieldRefusedError)
      expect((refused as FieldRefusedError).message).toBe(
        'Nothing changed: this geofence is not one your role in this organization can change.',
      )
    }
  })

  it('says a retired geofence does not change, whatever is written to it', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/geofences', {
      status: 400,
      body: {
        code: '23514',
        message: `geofence ${GEOFENCE_ID}: a retired geofence does not change`,
        details: null,
        hint: null,
      },
    })
    const changed = await backend
      .changeGeofence(GEOFENCE_ID, { name: 'Norte Alfa' })
      .catch((error: unknown) => error)
    const retired = await backend.retireGeofence(GEOFENCE_ID).catch((error: unknown) => error)
    for (const refused of [changed, retired]) {
      expect(refused).toMatchObject({
        field: null,
        code: '23514',
        message: 'A retired geofence does not change.',
      })
    }
  })

  it('passes on a failure it does not name as a plain error', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/geofences', {
      status: 500,
      body: { code: 'XX000', message: 'the database is busy', details: null, hint: null },
    })
    const failure = await backend.geofences(ORGANIZATION).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect(failure).not.toBeInstanceOf(FieldRefusedError)
    expect(failure).toMatchObject({ message: 'the database is busy', code: 'XX000' })
  })
})

describe('the waylines through PostgREST (IR-WAY, FR-WAY-09)', () => {
  it("reads the organization's live waylines, their baked result as saved", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/waylines', { status: 200, body: [WAYLINE_ROW] })
    expect(await backend.waylines(ORGANIZATION)).toEqual([
      {
        id: WAYLINE_ID,
        name: 'Ronda',
        takeoff: WAYLINE_DRAFT.takeoff,
        defaultHeightM: 40,
        speedMs: 5,
        design: { schema_version: '1.0.0', primitives: [] },
        waypoints: WAYLINE_DRAFT.waypoints,
        metrics: { waypointCount: 2, distanceM: 1234.5, durationS: 300 },
        bakeVersion: '1.0.0',
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ])
    const query = last(supabase).url.searchParams
    expect([query.get('organization_id'), query.get('deleted_at'), query.get('order')]).toEqual([
      `eq.${ORGANIZATION}`,
      'is.null',
      'name.asc',
    ])
  })

  it('creates a wayline with its columns: the takeoff and the waypoints as pairs', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/waylines', { status: 201, body: WAYLINE_ROW })
    expect(await backend.createWayline(ORGANIZATION, WAYLINE_DRAFT)).toMatchObject({
      id: WAYLINE_ID,
      bakeVersion: '1.0.0',
    })
    const request = last(supabase)
    expect(request.headers.get('content-profile')).toBe('soc')
    expect(request.body).toEqual({
      organization_id: ORGANIZATION,
      name: 'Ronda',
      takeoff: [-4.7245, 41.6523],
      default_height_m: 40,
      speed_ms: 5,
      design: { schema_version: '1.0.0', primitives: [] },
      waypoints: [
        { index: 0, position: [-4.7245, 41.6523], height_m: 40 },
        { index: 1, position: [-4.71, 41.64], height_m: 45, speed_ms: 4 },
      ],
      metrics: { waypoint_count: 2, distance_m: 1234.5, duration_s: 300 },
      bake_version: '1.0.0',
    })
  })

  it('changes only the fields given, and a bake changes its columns together', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/waylines', { status: 200, body: [WAYLINE_ROW] })
    await backend.changeWayline(WAYLINE_ID, { name: 'Ronda alta' })
    expect(last(supabase).body).toEqual({ name: 'Ronda alta' })
    await backend.changeWayline(WAYLINE_ID, {
      waypoints: [
        { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 40 },
      ],
      metrics: { waypointCount: 1, distanceM: 0, durationS: 0 },
      bakeVersion: '1.0.1',
    })
    expect(last(supabase).body).toEqual({
      waypoints: [{ index: 0, position: [-4.7245, 41.6523], height_m: 40 }],
      metrics: { waypoint_count: 1, distance_m: 0, duration_s: 0 },
      bake_version: '1.0.1',
    })
  })

  it('retires by a timestamp the database sets, and refuses a change row security left untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/waylines', { status: 200, body: [{ id: WAYLINE_ID }] })
    await backend.retireWayline(WAYLINE_ID)
    expect(Object.keys(last(supabase).body as object)).toEqual(['deleted_at'])
    supabase.answers.set('PATCH /rest/v1/waylines', { status: 200, body: [] })
    const changed = await backend
      .changeWayline(WAYLINE_ID, { name: 'Ronda alta' })
      .catch((error: unknown) => error)
    expect(changed).toMatchObject({
      message:
        'Nothing changed: this wayline is not one your role in this organization can change.',
    })
    const retired = await backend.retireWayline(WAYLINE_ID).catch((error: unknown) => error)
    expect(retired).toBeInstanceOf(FieldRefusedError)
  })

  it('says a retired wayline does not change', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/waylines', {
      status: 400,
      body: {
        code: '23514',
        message: `wayline ${WAYLINE_ID}: a retired wayline does not change`,
        details: null,
        hint: null,
      },
    })
    await expect(backend.changeWayline(WAYLINE_ID, { name: 'Ronda alta' })).rejects.toThrow(
      'A retired wayline does not change.',
    )
  })

  it('says a viewer may not create a wayline', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/waylines', {
      status: 403,
      body: {
        code: '42501',
        message: 'new row violates row-level security policy for table "waylines"',
        details: null,
        hint: null,
      },
    })
    const refusal = await backend
      .createWayline(ORGANIZATION, WAYLINE_DRAFT)
      .catch((error: unknown) => error)
    expect(refusal).toMatchObject({
      field: null,
      code: '42501',
      message: 'Only editors and owners change waylines.',
    })
  })

  it.each([
    ['wayline_name_given', 'name', 'A wayline needs a name.'],
    [
      'wayline_takeoff_position',
      'takeoff',
      'The takeoff point needs a longitude and a latitude in range.',
    ],
    [
      'wayline_default_height_positive',
      'defaultHeightM',
      "A wayline's default height must be above zero.",
    ],
    ['wayline_speed_positive', 'speedMs', "A wayline's speed must be above zero."],
    ['wayline_design_object', 'design', 'The design must be an object.'],
    [
      'wayline_waypoints_baked',
      'waypoints',
      'A wayline needs baked waypoints, each with a position and a height above zero.',
    ],
    [
      'wayline_metrics_object',
      'metrics',
      'The metrics of the bake need a waypoint count, a distance and a duration, as numbers.',
    ],
    [
      'wayline_bake_version_given',
      'bakeVersion',
      'A wayline needs the version of the bake that produced it.',
    ],
  ])('names the field the database refused for %s', async (constraint, field, text) => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/waylines', {
      status: 400,
      body: {
        code: '23514',
        message: `new row for relation "waylines" violates check constraint "${constraint}"`,
        details: null,
        hint: null,
      },
    })
    const refusal = await backend
      .createWayline(ORGANIZATION, WAYLINE_DRAFT)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(FieldRefusedError)
    expect(refusal).toMatchObject({ field, message: text, code: '23514' })
  })

  it('refuses a stored takeoff it cannot read, rather than showing a guess', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/waylines', {
      status: 200,
      body: [{ ...WAYLINE_ROW, takeoff: [-4.7245, 'north'] }],
    })
    await expect(backend.waylines(ORGANIZATION)).rejects.toThrow(BackendError)
  })

  it('reads a wayline without waypoint speeds, and refuses one with no waypoint', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/waylines', {
      status: 200,
      body: [
        {
          ...WAYLINE_ROW,
          waypoints: [{ index: 0, position: [-4.7245, 41.6523], height_m: '40', speed_ms: null }],
        },
      ],
    })
    const [wayline] = await backend.waylines(ORGANIZATION)
    expect(wayline?.waypoints).toEqual([
      { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 40 },
    ])
    supabase.answers.set('GET /rest/v1/waylines', {
      status: 200,
      body: [{ ...WAYLINE_ROW, waypoints: [] }],
    })
    await expect(backend.waylines(ORGANIZATION)).rejects.toThrow(
      'soc.waylines answered rows SOC cannot read',
    )
  })
})
