// @vitest-environment node
import {
  ConfigurationError,
  keyRole,
  loadRuntimeConfiguration,
  parseRuntimeConfiguration,
} from './runtime'
import { jwtFor, supabaseKey } from '../test/keys'

const FILE = {
  telemetry_stale_after_ms: 3000,
  telemetry_lost_after_ms: 10000,
  geofence_warning_band_m: 5,
  geofence_max_vertices: 32,
  max_arc_spacing_m: 10,
}
const VALID = {
  supabase_url: 'http://192.168.1.40:8000',
  supabase_key: jwtFor('anon'),
  settings: FILE,
}

function problemsOf(raw: unknown): readonly string[] {
  try {
    parseRuntimeConfiguration(raw)
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems
    throw error
  }
  throw new Error('the configuration was accepted')
}

function answering(body: string, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }))
}

describe('the runtime configuration', () => {
  it("accepts a LAN address, the public key and the console's file", () => {
    expect(parseRuntimeConfiguration(VALID)).toEqual({
      supabaseUrl: 'http://192.168.1.40:8000',
      supabaseKey: VALID.supabase_key,
      settings: {
        telemetryStaleAfterMs: 3000,
        telemetryLostAfterMs: 10000,
        geofenceWarningBandM: 5,
        geofenceMaxVertices: 32,
        maxArcSpacingM: 10,
      },
    })
  })

  it('accepts a publishable key and drops the trailing slash', () => {
    const configuration = parseRuntimeConfiguration({
      supabase_url: 'https://farm.example/',
      supabase_key: supabaseKey('publishable'),
      settings: FILE,
    })
    expect(configuration.supabaseUrl).toBe('https://farm.example')
  })

  it.each([
    ['service_role JWT', jwtFor('service_role'), 'is the service role key'],
    ['secret key', supabaseKey('secret'), 'is the service role key'],
    ['authenticated JWT', jwtFor('authenticated'), 'is a key for role authenticated'],
    ['random text', 'not-a-key', 'must be the public anon key'],
  ])('refuses a %s as the key', (_name, key, message) => {
    expect(problemsOf({ ...VALID, supabase_key: key })).toEqual([
      expect.stringContaining(`supabase_key: ${message}`),
    ])
  })

  it.each(['ftp://192.168.1.40', 'http://192.168.1.40:8000/rest/v1', 'localhost:8000', ''])(
    'refuses %j as the address',
    (url) => {
      expect(problemsOf({ ...VALID, supabase_url: url })).toEqual([
        expect.stringMatching(/^supabase_url: /),
      ])
    },
  )

  it('reports every problem at once and refuses unknown keys', () => {
    expect(problemsOf({ supabase_url: 'nope', extra: 1 })).toEqual([
      expect.stringMatching(/^supabase_url: /),
      expect.stringMatching(/^supabase_key: /),
      expect.stringMatching(/^settings: /),
      expect.stringMatching(/extra/),
    ])
  })

  it('refuses a console file that breaks the contract, naming each key (ADR-0019)', () => {
    const settings = {
      telemetry_stale_after_ms: 2999.5,
      telemetry_lost_after_ms: 400000,
      geofence_warning_band_m: '5',
      max_arc_spacing_m: 10,
      telemetry_batch_s: 5,
    }
    expect(problemsOf({ ...VALID, settings })).toEqual([
      expect.stringMatching(/^settings\.telemetry_stale_after_ms: /),
      expect.stringMatching(/^settings\.telemetry_lost_after_ms: /),
      expect.stringMatching(/^settings\.geofence_warning_band_m: /),
      expect.stringMatching(/^settings\.geofence_max_vertices: /),
      expect.stringMatching(/telemetry_batch_s/),
    ])
  })

  it('refuses a stale threshold that is not under the lost one', () => {
    const settings = { ...FILE, telemetry_stale_after_ms: 10000 }
    expect(problemsOf({ ...VALID, settings })).toEqual([
      'settings.telemetry_lost_after_ms: must hold telemetry_stale_after_ms < telemetry_lost_after_ms',
    ])
  })

  it('reads the key role of JWTs and keys', () => {
    expect(keyRole(jwtFor('anon'))).toBe('anon')
    expect(keyRole(supabaseKey('publishable'))).toBe('anon')
    expect(keyRole('a.b.c')).toBeNull()
  })
})

describe('loading the runtime configuration', () => {
  it('reads /config.json without the cache', async () => {
    const fetcher = vi.fn(answering(JSON.stringify(VALID)))
    await expect(loadRuntimeConfiguration(fetcher)).resolves.toMatchObject({
      supabaseUrl: VALID.supabase_url,
    })
    expect(fetcher).toHaveBeenCalledWith('/config.json', { cache: 'no-store' })
  })

  it.each([
    ['a missing file', answering('Not Found', 404), '/config.json answered HTTP 404'],
    ['a file that is not JSON', answering('<html>'), '/config.json is not JSON'],
    [
      'a network failure',
      () => Promise.reject(new TypeError('Failed to fetch')),
      '/config.json cannot be fetched: TypeError: Failed to fetch',
    ],
  ])('names %s', async (_name, fetcher, problem) => {
    await expect(loadRuntimeConfiguration(fetcher)).rejects.toMatchObject({ problems: [problem] })
  })
})
