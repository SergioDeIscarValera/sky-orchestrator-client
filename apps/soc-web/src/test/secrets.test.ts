// @vitest-environment node
import { readFileSync } from 'node:fs'

import { secretsIn } from '../../scripts/secrets.mjs'
import { jwtFor, supabaseKey } from './keys'

describe('the search of the built application for secrets (NFR-SEC-02)', () => {
  it.each([
    ['a JWT', `const key = "${jwtFor('service_role').replace('signature', 'abc')}"`],
    ['a Supabase secret key', `fetch(url, { headers: { apikey: "${supabaseKey('secret')}" } })`],
    ["a service's secret variable", 'process.env.SOC_SUPABASE_SERVICE_ROLE_KEY'],
    ["a service's secret variable", 'SOC_DB_PASSWORD_SOC_CLOUD'],
  ])('finds %s', (name, text) => {
    expect(secretsIn(text)).toEqual([name])
  })

  it("passes the web's own check for a secret key, which names its prefix only", () => {
    const source = readFileSync(new URL('../config/runtime.ts', import.meta.url), 'utf8')
    expect(source).toContain("'sb_secret_'")
    expect(secretsIn(source)).toEqual([])
  })
})
