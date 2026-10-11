// @vitest-environment node
import {
  ConfigurationError,
  keyRole,
  loadRuntimeConfiguration,
  parseRuntimeConfiguration,
} from './runtime'
import { jwtFor, supabaseKey } from '../test/keys'

const VALID = { supabase_url: 'http://192.168.1.40:8000', supabase_key: jwtFor('anon') }

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
  it('accepts a LAN address and the public key', () => {
    expect(parseRuntimeConfiguration(VALID)).toEqual({
      supabaseUrl: 'http://192.168.1.40:8000',
      supabaseKey: VALID.supabase_key,
    })
  })

  it('accepts a publishable key and drops the trailing slash', () => {
    const configuration = parseRuntimeConfiguration({
      supabase_url: 'https://farm.example/',
      supabase_key: supabaseKey('publishable'),
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
      expect.stringMatching(/extra/),
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
