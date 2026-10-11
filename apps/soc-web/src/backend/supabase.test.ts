import { ADDRESS, EMAIL, FakeSupabase, USER_ID } from '../test/fakeSupabase'
import { jwtFor, PASSWORD_FOR_TESTS } from '../test/keys'
import type { Account, Backend } from './backend'
import { SESSION_STORAGE_KEY, supabaseBackend } from './supabase'

const ORGANIZATION_ID = '0b6d3f1e-8a2c-4e5f-9b1a-7c3d2e1f0a9b'

function connect(supabase: FakeSupabase): Backend {
  return supabaseBackend(
    { supabaseUrl: ADDRESS, supabaseKey: jwtFor('anon') },
    { fetch: supabase.fetch, autoRefreshToken: false },
  )
}

async function signedIn(supabase = new FakeSupabase()): Promise<[Backend, FakeSupabase]> {
  const backend = connect(supabase)
  expect(await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)).toBeNull()
  return [backend, supabase]
}

describe('signing in through Supabase', () => {
  it('posts the password grant to GoTrue and keeps the session under its own key', async () => {
    const [, supabase] = await signedIn()
    const [request] = supabase.requests
    expect(request?.url.href).toBe(`${ADDRESS}/auth/v1/token?grant_type=password`)
    expect(request?.body).toMatchObject({ email: EMAIL, password: PASSWORD_FOR_TESTS })
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toContain(USER_ID)
  })

  it('tells each listener who is signed in, and when nobody is', async () => {
    const backend = connect(new FakeSupabase())
    const seen: (Account | null)[] = []
    const stop = backend.onAccountChange((account) => seen.push(account))
    await vi.waitFor(() => {
      expect(seen).toEqual([null])
    })
    await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)
    await backend.signOut()
    await vi.waitFor(() => {
      expect(seen).toEqual([null, { userId: USER_ID, email: EMAIL }, null])
    })
    stop()
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('names wrong credentials', async () => {
    const backend = connect(new FakeSupabase())
    expect(await backend.signIn(EMAIL, 'wrong')).toEqual({
      reason: 'credentials',
      detail: 'Invalid login credentials',
    })
  })

  it('names wrong credentials when CORS hides the error code from the browser', async () => {
    const supabase = new FakeSupabase()
    supabase.hidesApiVersion = true
    expect(await connect(supabase).signIn(EMAIL, 'wrong')).toMatchObject({ reason: 'credentials' })
  })

  it('names too many attempts', async () => {
    const supabase = new FakeSupabase()
    supabase.signInStatus = 429
    supabase.hidesApiVersion = true
    expect(await connect(supabase).signIn(EMAIL, PASSWORD_FOR_TESTS)).toMatchObject({
      reason: 'rate_limited',
    })
  })

  it('names an address that does not answer', async () => {
    const supabase = new FakeSupabase()
    supabase.unreachable = true
    expect(await connect(supabase).signIn(EMAIL, PASSWORD_FOR_TESTS)).toEqual({
      reason: 'unreachable',
      detail: ADDRESS,
    })
  })
})

describe('reading the member organizations', () => {
  it('calls soc.member_organizations as the signed-in user', async () => {
    const [backend, supabase] = await signedIn()
    supabase.organizations = [
      {
        id: ORGANIZATION_ID,
        name: 'Finca Norte',
        role: 'editor',
        latitude: 41.6523,
        longitude: -4.7245,
        timezone: 'Europe/Madrid',
      },
    ]
    expect(await backend.memberOrganizations()).toEqual([
      {
        id: ORGANIZATION_ID,
        name: 'Finca Norte',
        role: 'editor',
        position: { latitude: 41.6523, longitude: -4.7245 },
        timeZone: 'Europe/Madrid',
      },
    ])
    const request = supabase.requests.at(-1)
    expect(request?.url.href).toBe(`${ADDRESS}/rest/v1/rpc/member_organizations`)
    expect(request?.headers.get('accept-profile')).toBe('soc')
    expect(request?.headers.get('authorization')).toBe(`Bearer ${supabase.accessToken}`)
  })

  it('gives an organization with no position none', async () => {
    const [backend, supabase] = await signedIn()
    supabase.organizations = [
      {
        id: ORGANIZATION_ID,
        name: 'Almendral',
        role: 'viewer',
        latitude: null,
        longitude: null,
        timezone: null,
      },
    ]
    expect(await backend.memberOrganizations()).toMatchObject([{ position: null, timeZone: null }])
  })

  it("passes PostgREST's refusal on with its code", async () => {
    const [backend, supabase] = await signedIn()
    supabase.rpcFailure = {
      status: 406,
      body: { code: 'PGRST106', message: 'Invalid schema: soc', details: null, hint: null },
    }
    await expect(backend.memberOrganizations()).rejects.toMatchObject({
      code: 'PGRST106',
      message: 'Invalid schema: soc',
    })
  })

  it('refuses rows it cannot read rather than guessing', async () => {
    const [backend, supabase] = await signedIn()
    supabase.organizations = [{ id: 'not-a-uuid', name: 'X', role: 'admin' }]
    await expect(backend.memberOrganizations()).rejects.toThrow('rows SOC cannot read')
  })
})
