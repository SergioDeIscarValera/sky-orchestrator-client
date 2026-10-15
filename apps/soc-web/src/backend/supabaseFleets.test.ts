// @vitest-environment node
import { ADDRESS, EMAIL, FakeSupabase } from '../test/fakeSupabase'
import { jwtFor, PASSWORD_FOR_TESTS } from '../test/keys'
import { FieldRefusedError, type Backend, type StateEvent } from './backend'
import { supabaseBackend } from './supabase'
import { JOIN_SETTLE_MS, type StateChannel } from './supabaseFleets'

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const FLEET_ID = '33333333-3333-4333-8333-333333333333'
const GEOFENCE_ID = '44444444-4444-4444-8444-444444444444'
const WAYLINE_ID = '55555555-5555-4555-8555-555555555555'
const SPECS = 'https://www.dji.com/support/product/mavic-air-2'

const FLEET_ROW = {
  id: FLEET_ID,
  organization_id: ORGANIZATION,
  name: 'Norte 1',
  model: 'mavic-air-2',
  airframe_serial: '1WNBH9',
  controller_serial: null,
  gateway_sn: 'SOTESTDOCK01',
  aircraft_sn: 'SOTESTUAV001',
  flight_time_before_soc_s: 0,
  created_at: '2026-10-11T10:10:00+00:00',
  updated_at: '2026-10-11T10:10:00+00:00',
  deleted_at: null,
}

const DRAFT = {
  name: 'Norte 1',
  model: 'mavic-air-2',
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 3600,
}

class FakeChannel implements StateChannel {
  readonly handlers = new Map<
    string,
    (message: { event: string; payload: Record<string, unknown> }) => void
  >()
  joined: ((status: string) => void) | null = null
  unsubscribed = false

  on(
    _type: 'broadcast',
    filter: { event: string },
    callback: (message: { event: string; payload: Record<string, unknown> }) => void,
  ): StateChannel {
    this.handlers.set(filter.event, callback)
    return this
  }

  subscribe(callback: (status: string) => void): unknown {
    this.joined = callback
    return this
  }

  unsubscribe(): unknown {
    this.unsubscribed = true
    return this
  }
}

async function signedIn(
  channels: Map<string, FakeChannel> = new Map(),
  network: EventTarget = new EventTarget(),
) {
  const supabase = new FakeSupabase()
  const backend: Backend = supabaseBackend(
    { supabaseUrl: ADDRESS, supabaseKey: jwtFor('anon') },
    {
      fetch: supabase.fetch,
      autoRefreshToken: false,
      network,
      channel: (topic) => {
        const made = new FakeChannel()
        channels.set(topic, made)
        return made
      },
    },
  )
  await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)
  return { backend, supabase, channels }
}

function last(supabase: FakeSupabase) {
  const request = supabase.requests.at(-1)
  if (request === undefined) throw new Error('no request')
  return request
}

describe('the catalogue, the devices and the fleets through PostgREST', () => {
  it('reads the catalogue from schema soc, figures as numbers', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/aircraft_models', {
      status: 200,
      body: [
        {
          model: 'mavic-air-2',
          display_name: 'DJI Mavic Air 2',
          msdk_v4_support: 'partial',
          support_notes: 'Not supported: orientation.',
          max_horizontal_speed_ms: '19',
          max_ascent_speed_ms: '4',
          max_descent_speed_ms: '5',
          max_flight_time_s: 2040,
          max_service_ceiling_m: '5000',
          max_wind_resistance_ms: '8.5',
          weight_g: 570,
          camera: {
            sensor: '1/2" CMOS',
            photo_resolution: null,
            video_resolution: null,
            zoom: null,
          },
          thermal: { capability: 'none', resolution: null },
          sources: { weight_g: SPECS },
          source_urls: [SPECS],
        },
      ],
    })
    const [model] = await backend.aircraftModels()
    expect(model).toMatchObject({
      model: 'mavic-air-2',
      maxHorizontalSpeedMs: 19,
      maxWindResistanceMs: 8.5,
      camera: { sensor: '1/2" CMOS', photoResolution: null },
      sources: { weight_g: SPECS },
    })
    expect(last(supabase).url.searchParams.get('order')).toBe('display_name.asc')
    expect(last(supabase).headers.get('accept-profile')).toBe('soc')
  })

  it("reads the organization's devices through their stacks", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/devices', {
      status: 200,
      body: [
        {
          gateway_sn: 'SOTESTDOCK01',
          aircraft_sn: 'SOTESTUAV001',
          domain: 0,
          type: 91,
          sub_type: 0,
          online: true,
          firmware_version: null,
          first_seen_at: '2026-10-11T10:00:00+00:00',
          last_seen_at: '2026-10-11T10:05:00+00:00',
          stacks: { name: 'lab', link_state: 'connected' },
        },
      ],
    })
    expect(await backend.devices(ORGANIZATION)).toEqual([
      expect.objectContaining({
        aircraftSn: 'SOTESTUAV001',
        wireModel: '0-91-0',
        stack: { name: 'lab', linkState: 'connected' },
      }),
    ])
    const query = last(supabase).url.searchParams
    expect(query.get('select')).toBe('*,stacks!inner(name,link_state)')
    expect(query.get('stacks.organization_id')).toBe(`eq.${ORGANIZATION}`)
  })

  it("reads the organization's live fleets only", async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('GET /rest/v1/fleets', { status: 200, body: [FLEET_ROW] })
    expect(await backend.fleets(ORGANIZATION)).toEqual([
      expect.objectContaining({ id: FLEET_ID, airframeSerial: '1WNBH9', controllerSerial: null }),
    ])
    const query = last(supabase).url.searchParams
    expect([query.get('organization_id'), query.get('deleted_at')]).toEqual([
      `eq.${ORGANIZATION}`,
      'is.null',
    ])
  })

  it('registers a fleet with its columns and gets it back', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/fleets', { status: 201, body: FLEET_ROW })
    expect(await backend.registerFleet(ORGANIZATION, DRAFT)).toMatchObject({ id: FLEET_ID })
    const request = last(supabase)
    expect(request.headers.get('content-profile')).toBe('soc')
    expect(request.body).toEqual({
      organization_id: ORGANIZATION,
      gateway_sn: 'SOTESTDOCK01',
      aircraft_sn: 'SOTESTUAV001',
      name: 'Norte 1',
      model: 'mavic-air-2',
      airframe_serial: '1WNBH9',
      controller_serial: null,
      flight_time_before_soc_s: 3600,
    })
  })

  it('changes only the fields given and retires by a timestamp the database sets', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/fleets', { status: 200, body: [FLEET_ROW] })
    await backend.changeFleet(FLEET_ID, { name: 'Norte Alfa' })
    expect(last(supabase).body).toEqual({ name: 'Norte Alfa' })
    expect(last(supabase).url.searchParams.get('id')).toBe(`eq.${FLEET_ID}`)
    await backend.changeFleet(FLEET_ID, { gatewaySn: 'SOTESTDOCK02', aircraftSn: 'SOTESTUAV002' })
    expect(last(supabase).body).toEqual({
      gateway_sn: 'SOTESTDOCK02',
      aircraft_sn: 'SOTESTUAV002',
    })
    supabase.answers.set('PATCH /rest/v1/fleets', { status: 200, body: [{ id: FLEET_ID }] })
    await backend.retireFleet(FLEET_ID)
    expect(Object.keys(last(supabase).body as object)).toEqual(['deleted_at'])
  })

  it('refuses a change or a retirement that row security left untouched', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/fleets', { status: 200, body: [] })
    const changed = await backend
      .changeFleet(FLEET_ID, { name: 'Norte Alfa' })
      .catch((error: unknown) => error)
    const retired = await backend.retireFleet(FLEET_ID).catch((error: unknown) => error)
    for (const refused of [changed, retired]) {
      expect(refused).toBeInstanceOf(FieldRefusedError)
      expect((refused as FieldRefusedError).message).toMatch(/^Nothing changed/)
    }
  })

  it('says a retired fleet does not change', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/fleets', {
      status: 400,
      body: {
        code: '23514',
        message: `fleet ${FLEET_ID}: a retired fleet does not change`,
        details: null,
        hint: null,
      },
    })
    await expect(backend.changeFleet(FLEET_ID, { name: 'Norte Alfa' })).rejects.toThrow(
      'A retired fleet does not change.',
    )
  })

  it('says an aircraft that flies keeps its wire identity, which the trigger refuses to move (FR-FLE-05)', async () => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('PATCH /rest/v1/fleets', {
      status: 400,
      body: {
        code: '23514',
        message: `fleet ${FLEET_ID}: its aircraft is flying`,
        details: null,
        hint: null,
      },
    })
    const refused = await backend
      .changeFleet(FLEET_ID, { aircraftSn: 'SOTESTUAV002' })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(FieldRefusedError)
    expect(refused).toMatchObject({
      field: null,
      code: '23514',
      message: 'This aircraft is flying: its wire identity stays until its flight ends.',
    })
  })

  it.each([
    [
      400,
      '23514',
      'new row for relation "fleets" violates check constraint "fleet_name_given"',
      'name',
    ],
    [
      409,
      '23505',
      'duplicate key value violates unique constraint "fleets_one_live_per_device"',
      'aircraftSn',
    ],
    [
      400,
      '23502',
      'null value in column "model" of relation "fleets" violates not-null constraint',
      'model',
    ],
    [
      409,
      '23503',
      'insert or update on table "fleets" violates foreign key constraint "fleets_model_fkey"',
      'model',
    ],
    [403, '42501', 'new row violates row-level security policy for table "fleets"', null],
    [
      409,
      '23503',
      'insert or update on table "fleets" violates foreign key constraint "fleets_gateway_sn_aircraft_sn_fkey"',
      'aircraftSn',
    ],
    [
      409,
      '23503',
      'insert or update on table "fleets" violates foreign key constraint "fleets_gateway_sn_organization_id_fkey"',
      'gatewaySn',
    ],
  ])('names the field the database refused (%s %s)', async (status, code, message, field) => {
    const { backend, supabase } = await signedIn()
    supabase.answers.set('POST /rest/v1/fleets', {
      status,
      body: { code, message, details: null, hint: null },
    })
    const refusal = await backend
      .registerFleet(ORGANIZATION, DRAFT)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(FieldRefusedError)
    expect((refusal as FieldRefusedError).field).toBe(field)
  })
})

describe("the organization's state topic", () => {
  it('listens privately to every change and stops when asked', async () => {
    const { backend, channels } = await signedIn()
    const seen: StateEvent[] = []
    const stop = backend.onState(ORGANIZATION, (event) => seen.push(event))
    const channel = channels.get(`org:${ORGANIZATION}:soc:state`)
    expect(channel?.joined).not.toBeNull()
    expect([...(channel?.handlers.keys() ?? [])]).toEqual([
      'stack',
      'device',
      'fleet',
      'command_intent',
      'geofence',
      'wayline',
      'operation',
      'flight',
      'flight_state',
      'operation_event',
      'transition_request',
      'operation_check',
    ])
    channel?.handlers.get('device')?.({ event: 'device', payload: { online: false } })
    expect(seen).toEqual([{ kind: 'device', payload: { online: false } }])
    stop()
    expect(channel?.unsubscribed).toBe(true)
  })

  it("passes on a geofence's and a wayline's broadcast as the database sent it", async () => {
    const { backend, channels } = await signedIn()
    const seen: StateEvent[] = []
    backend.onState(ORGANIZATION, (event) => seen.push(event))
    const channel = channels.get(`org:${ORGANIZATION}:soc:state`)
    const geofence = {
      id: GEOFENCE_ID,
      name: 'Norte',
      origin: 'drawn',
      updated_at: '2026-10-11T10:12:00+00:00',
      deleted_at: null,
    }
    const wayline = {
      id: WAYLINE_ID,
      name: 'Ronda',
      updated_at: '2026-10-11T10:13:00+00:00',
      deleted_at: '2026-10-11T10:14:00+00:00',
    }
    channel?.handlers.get('geofence')?.({ event: 'geofence', payload: geofence })
    channel?.handlers.get('wayline')?.({ event: 'wayline', payload: wayline })
    expect(seen).toEqual([
      { kind: 'geofence', payload: geofence },
      { kind: 'wayline', payload: wayline },
    ])
  })

  it('says so on every join, since what was broadcast while away is lost', async () => {
    const { backend, channels } = await signedIn()
    const seen: StateEvent['kind'][] = []
    const stop = backend.onState(ORGANIZATION, ({ kind }) => seen.push(kind))
    const joined = channels.get(`org:${ORGANIZATION}:soc:state`)?.joined
    for (const status of ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'SUBSCRIBED'])
      joined?.(status)
    expect(seen).toEqual(['joined', 'joined'])
    stop()
  })

  describe('after a join, before Realtime is known to deliver to it', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function joinedOnce() {
      const { backend, channels } = await signedIn()
      const seen: StateEvent['kind'][] = []
      const stop = backend.onState(ORGANIZATION, ({ kind }) => seen.push(kind))
      const channel = channels.get(`org:${ORGANIZATION}:soc:state`)
      channel?.joined?.('SUBSCRIBED')
      const broadcast = (kind: string) => {
        channel?.handlers.get(kind)?.({ event: kind, payload: {} })
      }
      return { seen, stop, broadcast, rejoin: () => channel?.joined?.('SUBSCRIBED') }
    }

    it('reads everything once more with the first broadcast, and not with the next', async () => {
      const { seen, stop, broadcast } = await joinedOnce()
      broadcast('stack')
      broadcast('operation')
      expect(seen).toEqual(['joined', 'stack', 'joined', 'operation'])
      vi.advanceTimersByTime(JOIN_SETTLE_MS)
      expect(seen).toEqual(['joined', 'stack', 'joined', 'operation'])
      stop()
    })

    it('reads everything once more when no broadcast comes, and again with the first one', async () => {
      const { seen, stop, broadcast } = await joinedOnce()
      vi.advanceTimersByTime(JOIN_SETTLE_MS - 1)
      expect(seen).toEqual(['joined'])
      vi.advanceTimersByTime(1)
      expect(seen).toEqual(['joined', 'joined'])
      broadcast('operation')
      broadcast('operation')
      expect(seen).toEqual(['joined', 'joined', 'operation', 'joined', 'operation'])
      stop()
    })

    it('starts over on a rejoin, and reads nothing more once stopped', async () => {
      const { seen, stop, broadcast, rejoin } = await joinedOnce()
      broadcast('stack')
      rejoin()
      broadcast('stack')
      expect(seen).toEqual(['joined', 'stack', 'joined', 'joined', 'stack', 'joined'])
      rejoin()
      stop()
      vi.advanceTimersByTime(JOIN_SETTLE_MS)
      expect(seen.at(-1)).toBe('joined')
      expect(seen).toHaveLength(7)
    })
  })

  it('tells the console its link is down while the browser is offline (NFR-REL-07)', async () => {
    const network = new EventTarget()
    const { backend, channels } = await signedIn(new Map(), network)
    const seen: string[] = []
    const stopLink = backend.onLink((link) => seen.push(link))
    const stop = backend.onState(ORGANIZATION, () => undefined)
    const joined = channels.get(`org:${ORGANIZATION}:soc:state`)?.joined
    joined?.('SUBSCRIBED')
    network.dispatchEvent(new Event('offline'))
    network.dispatchEvent(new Event('online'))
    stop()
    stopLink()
    // Nobody listening any more, so going offline is nobody's news.
    network.dispatchEvent(new Event('offline'))
    expect(seen).toEqual(['up', 'down', 'up', 'connecting'])
  })
})
