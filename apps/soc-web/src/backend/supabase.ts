import {
  createClient,
  isAuthApiError,
  isAuthRetryableFetchError,
  type AuthError,
  type Session,
} from '@supabase/supabase-js'
import { z } from '../schema'

import type { RuntimeConfiguration } from '../config/runtime'
import {
  BackendError,
  type Account,
  type Backend,
  type Organization,
  type SignInFailure,
} from './backend'

export const SESSION_STORAGE_KEY = 'soc.session'

const ORGANIZATION_ROWS = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    role: z.enum(['owner', 'editor', 'viewer']),
    latitude: z.nullable(z.number()),
    longitude: z.nullable(z.number()),
    timezone: z.nullable(z.string()),
  }),
)

const REFUSALS_BY_CODE: Readonly<Record<string, SignInFailure['reason']>> = {
  invalid_credentials: 'credentials',
  email_not_confirmed: 'unconfirmed',
  over_request_rate_limit: 'rate_limited',
}

// A browser sees GoTrue's error code only when CORS exposes its API version
// header; behind a proxy that does not, the message is all that arrives.
const REFUSALS_BY_MESSAGE: Readonly<Record<string, SignInFailure['reason']>> = {
  'Invalid login credentials': 'credentials',
  'Email not confirmed': 'unconfirmed',
}

const TOO_MANY_REQUESTS = 429

export interface SupabaseOptions {
  readonly fetch?: typeof fetch
  readonly autoRefreshToken?: boolean
}

export function supabaseBackend(
  configuration: RuntimeConfiguration,
  options: SupabaseOptions = {},
): Backend {
  const client = createClient(configuration.supabaseUrl, configuration.supabaseKey, {
    auth: {
      storageKey: SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: options.autoRefreshToken ?? true,
      detectSessionInUrl: false,
    },
    global: options.fetch === undefined ? {} : { fetch: options.fetch },
  })

  return {
    address: configuration.supabaseUrl,

    onAccountChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        listener(accountOf(session))
      })
      return () => {
        data.subscription.unsubscribe()
      }
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password })
      return error === null ? null : refusal(error, configuration.supabaseUrl)
    },

    async signOut() {
      await client.auth.signOut({ scope: 'local' })
    },

    async memberOrganizations() {
      const response = await client
        .schema('soc')
        .rpc('member_organizations', undefined, { get: true })
      if (response.error !== null) {
        throw new BackendError(response.error.message, response.error.code)
      }
      const rows = ORGANIZATION_ROWS.safeParse(response.data)
      if (!rows.success) {
        throw new BackendError(`soc.member_organizations answered rows SOC cannot read`)
      }
      return rows.data.map((row): Organization => ({
        id: row.id,
        name: row.name,
        role: row.role,
        position:
          row.latitude === null || row.longitude === null
            ? null
            : { latitude: row.latitude, longitude: row.longitude },
        timeZone: row.timezone,
      }))
    },
  }
}

function accountOf(session: Session | null): Account | null {
  return session === null ? null : { userId: session.user.id, email: session.user.email ?? '' }
}

function refusal(error: AuthError, address: string): SignInFailure {
  if (isAuthRetryableFetchError(error)) return { reason: 'unreachable', detail: address }
  if (!isAuthApiError(error)) return { reason: 'other', detail: error.message }
  if (error.status === TOO_MANY_REQUESTS) return { reason: 'rate_limited', detail: error.message }
  const reason =
    (error.code === undefined ? undefined : REFUSALS_BY_CODE[error.code]) ??
    REFUSALS_BY_MESSAGE[error.message]
  return { reason: reason ?? 'other', detail: error.message }
}
