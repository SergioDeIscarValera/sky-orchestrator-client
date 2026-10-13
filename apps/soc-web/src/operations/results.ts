import type { CommandVerb } from '../backend/backend'

/*
 * What a refusal from Sky Orchestrator means to the operator (FR-OPS-09, FR-CMD-06). This mirrors
 * contracts/results/results.json, which results.test.ts holds equal to it. A code means different
 * things by the DJI method that drew it (ADR-0037), so every meaning sits under its method.
 */

/** The DJI method a verb is sent as, keyed as contracts/results/results.json names it. */
export type ResultMethod =
  | 'flighttask_prepare'
  | 'flighttask_execute'
  | 'flighttask_pause'
  | 'flighttask_recovery'
  | 'return_home'
  | 'flighttask_undo'

export const RESULTS_VERSION = '1.0.0'

/** What a code with no entry reads as; the console shows it with the code's number. */
export const RESULT_DEFAULT = 'Sky Orchestrator refused it'

/**
 * A meaning that depends on the stack's status. The console does not judge that status, so it shows
 * the `otherwise` words, and the conditions are kept for the contract's own readers.
 */
export interface StatusMeanings {
  readonly by_status: readonly { readonly when: string; readonly meaning: string }[]
  readonly otherwise: string
}

export type ResultMeaning = string | StatusMeanings

export const RESULT_MEANINGS: Readonly<
  Record<ResultMethod, Readonly<Record<string, ResultMeaning>>>
> = {
  flighttask_prepare: {
    '314010':
      "This file has not completed a simulation on this stack, or lies outside the phone's own envelope: the phone's record names the distance",
    '314003': 'Sky Orchestrator refused the file',
    '319015': "The stack's mode is not known yet",
    '319004': 'The task was prepared under the other mode: cancel it and prepare again',
    '319016': 'The stack has another task prepared: one task at a time',
  },
  flighttask_execute: {
    '314010':
      "Arm the phone, release the aircraft held from the phone's console, or confirm real flight on the phone's screen, and retry",
    '316010': {
      by_status: [
        { when: 'link_down', meaning: 'The link to the phone is down' },
        { when: 'real_mode_simulator_active', meaning: "Turn the phone's simulator off" },
        { when: 'simulator_mode_simulator_inactive', meaning: "Turn the phone's simulator on" },
      ],
      otherwise: 'The aircraft is not detected',
    },
    '319999':
      "The outcome is not known yet: SOC reads the flight's progress and the stack's status",
    '319015': "The stack's mode is not known yet",
    '319004': 'The task was prepared under the other mode: cancel it and prepare again',
  },
  flighttask_pause: {},
  flighttask_recovery: {
    '319999': "The outcome is not known yet: SOC reads the flight's progress",
  },
  return_home: {},
  flighttask_undo: {},
}

/** The method each verb a command carries is sent as: the one that draws its results. */
export const METHOD_OF_VERB: Readonly<Record<CommandVerb, ResultMethod>> = {
  prepare: 'flighttask_prepare',
  execute: 'flighttask_execute',
  pause: 'flighttask_pause',
  recovery: 'flighttask_recovery',
  return_home: 'return_home',
  undo: 'flighttask_undo',
}

/**
 * The words for a result code a verb's command drew: its meaning, its `otherwise` words for a meaning
 * that depends on the status, or the default for a code with no entry under the verb's method.
 */
export function resultWords(verb: CommandVerb, code: number): string {
  const entries = RESULT_MEANINGS[METHOD_OF_VERB[verb]]
  const key = String(code)
  if (!Object.hasOwn(entries, key)) return RESULT_DEFAULT
  const meaning: ResultMeaning | undefined = entries[key]
  if (meaning === undefined) return RESULT_DEFAULT
  return typeof meaning === 'string' ? meaning : meaning.otherwise
}
