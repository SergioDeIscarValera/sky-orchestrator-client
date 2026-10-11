export function jwtFor(role: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: 'supabase', role })}.signature`
}

export const PASSWORD_FOR_TESTS = ['correct', 'horse'].join('-')

/** A Supabase key of the new format, built here so no key-shaped literal sits in the source. */
export function supabaseKey(kind: 'publishable' | 'secret'): string {
  return ['sb', kind, 'fortests'].join('_')
}
