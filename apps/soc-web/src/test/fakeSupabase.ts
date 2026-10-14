import { jwtFor, PASSWORD_FOR_TESTS } from './keys'

export const ADDRESS = 'http://192.168.1.40:8000'
export const USER_ID = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
export const EMAIL = 'pilot@farm.test'

const API_VERSION = { 'x-supabase-api-version': '2024-01-01' }

export interface Recorded {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

/** GoTrue and PostgREST as far as the web uses them, behind `fetch`. */
export class FakeSupabase {
  readonly requests: Recorded[] = []
  readonly accessToken = jwtFor('authenticated')
  organizations: object = []
  rpcFailure: { status: number; body: object } | null = null
  /** Answers for PostgREST tables, by method and path: `GET /rest/v1/fleets`. */
  readonly answers = new Map<string, { status: number; body: object | null }>()
  /** The most rows an array answer holds, as PostgREST caps a response (Supabase's default is 1,000). */
  maxRows = Number.POSITIVE_INFINITY
  unreachable = false
  /** As a browser sees GoTrue when CORS does not expose its API version header. */
  hidesApiVersion = false
  signInStatus: number | null = null

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const recorded: Recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    }
    this.requests.push(recorded)
    if (this.unreachable) throw new TypeError('Failed to fetch')
    return this.answer(recorded)
  }

  private answer({ method, url, body }: Recorded): Response {
    const route = `${method} ${url.pathname}`
    if (route === 'POST /auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const { email, password } = body as { email: string; password: string }
      if (this.signInStatus !== null) {
        return this.json(this.signInStatus, {
          code: 'over_request_rate_limit',
          message: 'Slow down',
        })
      }
      if (email === EMAIL && password === PASSWORD_FOR_TESTS) return this.json(200, this.session())
      return this.json(400, { code: 'invalid_credentials', message: 'Invalid login credentials' })
    }
    if (route === 'POST /auth/v1/logout') return new Response(null, { status: 204 })
    if (route === 'GET /rest/v1/rpc/member_organizations') {
      if (this.rpcFailure !== null) return this.json(this.rpcFailure.status, this.rpcFailure.body)
      return this.json(200, this.organizations)
    }
    const answer = this.answers.get(route)
    if (answer !== undefined) {
      return answer.body === null
        ? new Response(null, { status: answer.status })
        : this.json(answer.status, this.windowed(answer.body, url))
    }
    return this.json(404, { message: `the fake has no ${route}` })
  }

  /** An array answer as PostgREST windows it: the offset and limit the request names, capped at `maxRows`. */
  private windowed(body: object, url: URL): object {
    if (!Array.isArray(body)) return body
    const rows: readonly unknown[] = body
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? Number.POSITIVE_INFINITY)
    return rows.slice(offset, offset + Math.min(limit, this.maxRows))
  }

  private json(status: number, body: object): Response {
    const version = this.hidesApiVersion ? {} : API_VERSION
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...version },
    })
  }

  private session(): object {
    return {
      access_token: this.accessToken,
      refresh_token: 'refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: USER_ID, email: EMAIL, aud: 'authenticated', role: 'authenticated' },
    }
  }
}
