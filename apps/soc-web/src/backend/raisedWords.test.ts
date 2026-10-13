// @vitest-environment node
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RAISED, ROLE_SAID } from './supabaseOperations'

// PostgREST sends a raised refusal's message and no constraint name, so the adapter reads
// the refusal by its words: they must stay the words migration 0010 raises.
const MIGRATION = readFileSync(
  new URL('../../../../database/migrations/0010-operations.sql', import.meta.url),
  'utf8',
)
const RAISED_MESSAGES = [...MIGRATION.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((match) =>
  (match[1] ?? '').replaceAll("''", "'"),
)
const CONSTRAINTS = new Set(
  [...MIGRATION.matchAll(/constraint = '([a-z_]+)'/g)].map((match) => match[1]),
)

describe("the words a refusal is read by, against migration 0010's own", () => {
  it.each(RAISED.map(([words, constraint]) => [constraint, words] as const))(
    '%s is raised in the words the adapter reads',
    (constraint, words) => {
      expect(RAISED_MESSAGES.some((message) => words.test(message))).toBe(true)
      expect(CONSTRAINTS.has(constraint)).toBe(true)
    },
  )

  it.each(ROLE_SAID.map(([words]) => [String(words), words] as const))(
    'a role refusal %s is raised in those words',
    (_, words) => {
      expect(RAISED_MESSAGES.some((message) => words.test(message))).toBe(true)
    },
  )

  it('finds the messages it checks', () => {
    expect(RAISED_MESSAGES.length).toBeGreaterThan(20)
  })
})
