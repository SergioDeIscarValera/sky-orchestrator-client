// @vitest-environment node
import { readFileSync } from 'node:fs'

import type { CommandVerb } from '../backend/backend'
import {
  METHOD_OF_VERB,
  RESULTS_VERSION,
  RESULT_DEFAULT,
  RESULT_MEANINGS,
  resultWords,
  type ResultMethod,
} from './results'

/** The meanings of Sky Orchestrator's results, as contracts/results/results.json holds them (FR-OPS-09). */
const CONTRACT = new URL('../../../../contracts/results/results.json', import.meta.url)

interface Contract {
  readonly 'x-version': string
  readonly default: string
  readonly results: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract

const VERBS = Object.keys(METHOD_OF_VERB) as CommandVerb[]

/** The verb a method draws its results for: each method is the method of exactly one verb. */
function verbOf(method: string): CommandVerb {
  const verb = VERBS.find((candidate) => METHOD_OF_VERB[candidate] === method)
  if (verb === undefined) throw new Error(`no verb is sent as ${method}`)
  return verb
}

/** Every code of every method the contract names, as the verb that draws it, the code and its words. */
const CASES = Object.entries(contract.results).flatMap(([method, codes]) =>
  Object.entries(codes).map(([code, meaning]) => {
    const words =
      typeof meaning === 'string' ? meaning : (meaning as { readonly otherwise: string }).otherwise
    return [verbOf(method), code, words] as const
  }),
)

describe("the results' meanings (FR-OPS-09, FR-CMD-06)", () => {
  it('keeps the version and the default equal to the contract', () => {
    expect(RESULTS_VERSION).toBe(contract['x-version'])
    expect(RESULT_DEFAULT).toBe(contract.default)
  })

  it('names exactly the methods the contract names', () => {
    expect(Object.keys(RESULT_MEANINGS).sort()).toEqual(Object.keys(contract.results).sort())
  })

  it.each(Object.keys(contract.results))(
    'holds the meanings of %s equal to the contract',
    (method) => {
      expect(RESULT_MEANINGS[method as ResultMethod]).toEqual(contract.results[method])
    },
  )

  it('sends every verb as a method the contract names', () => {
    for (const verb of VERBS) {
      expect(Object.keys(contract.results)).toContain(METHOD_OF_VERB[verb])
    }
  })

  it.each(CASES)('reads %s with code %s as the contract words it', (verb, code, words) => {
    expect(resultWords(verb, Number(code))).toBe(words)
  })

  it('shows the default for a code with no entry under the method, and no code is shared', () => {
    expect(resultWords('execute', 999999)).toBe(RESULT_DEFAULT)
    expect(resultWords('prepare', 316010)).toBe(RESULT_DEFAULT)
  })

  it.each(['pause', 'return_home', 'undo'] as const)(
    'shows the default for every code of %s, whose method has no entries in the contract',
    (verb) => {
      expect(resultWords(verb, 314010)).toBe(RESULT_DEFAULT)
      expect(resultWords(verb, 319999)).toBe(RESULT_DEFAULT)
    },
  )

  it('tells one code apart by the method that drew it', () => {
    expect(resultWords('prepare', 314010)).toBe(
      "This file has not completed a simulation on this stack, lies outside the phone's own envelope, or asks a return height the aircraft did not take: the phone's record names which",
    )
    expect(resultWords('execute', 314010)).toBe(
      "Arm the phone, release the aircraft held from the phone's console, or confirm real flight on the phone's screen, and retry",
    )
  })

  it("shows a status-dependent meaning's otherwise words, never a status's own, since the console does not judge the stack", () => {
    expect(resultWords('execute', 316010)).toBe('The aircraft is not detected')
    expect(resultWords('execute', 316010)).not.toBe('The link to the phone is down')
    expect(resultWords('execute', 316010)).not.toBe("Turn the phone's simulator off")
  })

  it('reads the unknown outcome of a recovery as the file says it', () => {
    expect(resultWords('recovery', 319999)).toBe(
      "The outcome is not known yet: SOC reads the flight's progress",
    )
  })
})
