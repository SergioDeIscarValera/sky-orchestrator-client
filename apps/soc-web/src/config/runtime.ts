import { z } from '../schema'
import { settingsOf, settingsSchema, type Settings } from './settings'

export interface RuntimeConfiguration {
  readonly supabaseUrl: string
  readonly supabaseKey: string
  /** soc-web's configuration file, as the container was given it (ADR-0023). */
  readonly settings: Settings
}

export class ConfigurationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`configuration refused: ${problems.join('; ')}`)
    this.problems = problems
  }
}

export const CONFIGURATION_PATH = '/config.json'

const PUBLIC_ROLE = 'anon'

const schema = z.strictObject({
  supabase_url: z.string().check(z.refine(isBareHttpUrl, 'must be an http(s) URL with no path')),
  supabase_key: z.string().check(
    z.superRefine((key, context) => {
      if (keyRole(key) !== PUBLIC_ROLE) {
        context.addIssue({ code: 'custom', message: describeKey(key) })
      }
    }),
  ),
  settings: settingsSchema,
})

export async function loadRuntimeConfiguration(
  fetcher: typeof fetch = fetch,
): Promise<RuntimeConfiguration> {
  let response: Response
  try {
    response = await fetcher(CONFIGURATION_PATH, { cache: 'no-store' })
  } catch (error) {
    throw new ConfigurationError([`${CONFIGURATION_PATH} cannot be fetched: ${String(error)}`])
  }
  if (!response.ok) {
    throw new ConfigurationError([`${CONFIGURATION_PATH} answered HTTP ${String(response.status)}`])
  }
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ConfigurationError([`${CONFIGURATION_PATH} is not JSON`])
  }
  return parseRuntimeConfiguration(raw)
}

export function parseRuntimeConfiguration(raw: unknown): RuntimeConfiguration {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(the file)'}: ${issue.message}`,
      ),
    )
  }
  return {
    supabaseUrl: parsed.data.supabase_url.replace(/\/$/, ''),
    supabaseKey: parsed.data.supabase_key,
    settings: settingsOf(parsed.data.settings),
  }
}

export function keyRole(key: string): string | null {
  if (key.startsWith('sb_publishable_')) return PUBLIC_ROLE
  if (key.startsWith('sb_secret_')) return 'service_role'
  const parts = key.split('.')
  if (parts.length !== 3 || parts[1] === undefined) return null
  try {
    const payload: unknown = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    const role = z.object({ role: z.string() }).safeParse(payload)
    return role.success ? role.data.role : null
  } catch {
    return null
  }
}

function isBareHttpUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return (
    ['http:', 'https:'].includes(parsed.protocol) &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === ''
  )
}

function describeKey(key: string): string {
  const role = keyRole(key)
  if (role === 'service_role') {
    return 'is the service role key, which must never reach a browser (NFR-SEC-02); give the public anon or publishable key'
  }
  return role === null
    ? 'must be the public anon key (a JWT) or a publishable key (sb_publishable_…)'
    : `is a key for role ${role}; give the public anon or publishable key`
}
