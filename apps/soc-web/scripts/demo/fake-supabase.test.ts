// @vitest-environment node
import { FieldRefusedError, type Backend, type Fleet } from '../../src/backend/backend'
import { supabaseBackend } from '../../src/backend/supabase'
import { parseRuntimeConfiguration } from '../../src/config/runtime'
import { PASSWORD_FOR_TESTS } from '../../src/test/keys'
import { startFakeSupabase, type FakeSupabase } from './fake-supabase.mjs'
import { DEMO_SETTINGS, demoSupabaseKey } from './run.mjs'
import { REPLAY } from '../../src/telemetry/replay'

const EMAIL = 'pilot@farm.test'
const NORTH = '11111111-1111-4111-8111-111111111111'
const ALMENDRAL = '22222222-2222-4222-8222-222222222222'
const NO_FLEET_AIRCRAFT = '3YTBJ7R0021ZK9'
const UNKNOWN_FLEET = '44444444-4444-4444-8444-444444444444'

const SECOND_FLEET = {
  name: 'Norte 2',
  model: 'mavic-air-2',
  airframeSerial: '3YTBJ7',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: NO_FLEET_AIRCRAFT,
  flightTimeBeforeSocS: 0,
}

let fake: FakeSupabase
let backend: Backend

function connect(url: string): Backend {
  return supabaseBackend(
    { supabaseUrl: url, supabaseKey: demoSupabaseKey() },
    { autoRefreshToken: false },
  )
}

async function fleetNames(organizationId: string): Promise<string[]> {
  return (await backend.fleets(organizationId)).map(({ name }) => name)
}

async function fleetNamed(name: string): Promise<Fleet> {
  const fleet = (await backend.fleets(NORTH)).find((candidate) => candidate.name === name)
  if (fleet === undefined) throw new Error(`no fleet named ${name}`)
  return fleet
}

beforeAll(async () => {
  fake = await startFakeSupabase({ port: 0 })
  backend = connect(fake.url)
  expect(await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)).toBeNull()
})

afterAll(async () => {
  await fake.close()
})

describe('the demo Supabase, read through the console backend', () => {
  it('answers the two organizations of the signed-in user', async () => {
    const organizations = await backend.memberOrganizations()
    expect(organizations.map(({ name, role }) => [name, role])).toEqual([
      ['Finca Norte', 'owner'],
      ['Almendral', 'viewer'],
    ])
  })

  it('answers the 38 models of the catalogue', async () => {
    expect(await backend.aircraftModels()).toHaveLength(38)
  })

  it('answers an unpublished figure as null, never as a text that reads as NaN', async () => {
    const models = await backend.aircraftModels()
    expect(models.find(({ model }) => model === 'inspire-1-pro')?.maxHorizontalSpeedMs).toBeNull()
    const figures = models.flatMap((model) => [
      model.maxHorizontalSpeedMs,
      model.maxAscentSpeedMs,
      model.maxDescentSpeedMs,
      model.maxFlightTimeS,
      model.maxServiceCeilingM,
      model.maxWindResistanceMs,
      model.weightG,
    ])
    expect(figures.filter((figure) => figure !== null && !Number.isFinite(figure))).toEqual([])
  })

  it('answers a browser preflight for the headers the console sends, Authorization included', async () => {
    const response = await fetch(`${fake.url}/rest/v1/fleets`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5199',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization, apikey, content-type, prefer',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization, apikey, content-type, prefer',
    )
  })

  it('answers the aircraft of Finca Norte: three on stack lab, and the replay on its own', async () => {
    const devices = await backend.devices(NORTH)
    expect(
      devices.map(({ aircraftSn, online, stack }) => [
        aircraftSn,
        online,
        stack.name,
        stack.linkState,
      ]),
    ).toEqual([
      ['1WNBH9E00A0042', true, 'lab', 'connected'],
      [NO_FLEET_AIRCRAFT, true, 'lab', 'connected'],
      ['5HPCJ4T00D2M77', true, 'lab', 'unreachable'],
      ['REPLAYUAV', true, 'replay', 'connected'],
    ])
    expect(devices.at(-1)?.gatewaySn).toBe(REPLAY.gatewaySn)
  })

  it('answers the one fleet of Finca Norte, and nothing for Almendral', async () => {
    expect(await fleetNames(NORTH)).toEqual(['Norte 1'])
    expect(await backend.devices(ALMENDRAL)).toEqual([])
    expect(await backend.fleets(ALMENDRAL)).toEqual([])
  })

  it('registers the aircraft without a fleet as a second fleet', async () => {
    const fleet = await backend.registerFleet(NORTH, SECOND_FLEET)
    expect(fleet).toMatchObject({ name: 'Norte 2', aircraftSn: NO_FLEET_AIRCRAFT })
    expect(await fleetNames(NORTH)).toEqual(['Norte 1', 'Norte 2'])
  })

  it('refuses a second live fleet for the same aircraft, and names the field', async () => {
    const refusal = await backend
      .registerFleet(NORTH, SECOND_FLEET)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(FieldRefusedError)
    expect(refusal).toMatchObject({ field: 'aircraftSn', code: '23505' })
  })

  it('changes a fleet, and answers the row it changed', async () => {
    const second = await fleetNamed('Norte 2')
    expect(await backend.changeFleet(second.id, { name: 'Norte 2 (hangar)' })).toMatchObject({
      id: second.id,
      name: 'Norte 2 (hangar)',
    })
    expect(await fleetNames(NORTH)).toEqual(['Norte 1', 'Norte 2 (hangar)'])
  })

  it('names a change to a fleet that is not there, which the database answers with no row', async () => {
    await expect(backend.changeFleet(UNKNOWN_FLEET, { name: 'Nobody' })).rejects.toThrow(
      'Nothing changed',
    )
  })

  it('retires a fleet, which then no longer lists', async () => {
    await backend.retireFleet((await fleetNamed('Norte 2 (hangar)')).id)
    expect(await fleetNames(NORTH)).toEqual(['Norte 1'])
  })
})

describe('signing in to the demo', () => {
  const token = async (grant: string, body: Readonly<Record<string, string>>) => {
    const response = await fetch(`${fake.url}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload: unknown = await response.json()
    return { status: response.status, payload }
  }

  it('accepts any email with any password', async () => {
    expect(await connect(fake.url).signIn('someone.else@farm.test', PASSWORD_FOR_TESTS)).toBeNull()
  })

  it('refuses an empty password as GoTrue refuses wrong credentials', async () => {
    const nothing = ''
    const refused = await token('password', { email: EMAIL, password: nothing })
    expect(refused.status).toBe(400)
    expect(refused.payload).toMatchObject({ code: 'invalid_credentials' })
  })

  it('renews a session with its refresh token, which then serves once', async () => {
    const signedIn = await token('password', { email: EMAIL, password: PASSWORD_FOR_TESTS })
    const { refresh_token: refresh } = signedIn.payload as { refresh_token: string }
    expect(await token('refresh_token', { refresh_token: refresh })).toMatchObject({ status: 200 })
    expect(await token('refresh_token', { refresh_token: refresh })).toMatchObject({ status: 400 })
  })
})

describe("the demo's configuration", () => {
  it("passes the console's own check, with the anon key the console expects", () => {
    expect(
      parseRuntimeConfiguration({
        supabase_url: fake.url,
        supabase_key: demoSupabaseKey(),
        settings: DEMO_SETTINGS,
      }),
    ).toMatchObject({
      supabaseUrl: fake.url,
      settings: {
        telemetryStaleAfterMs: 3000,
        telemetryLostAfterMs: 10000,
        geofenceWarningBandM: 5,
        geofenceMaxVertices: 32,
        maxArcSpacingM: 10,
      },
    })
  })
})
