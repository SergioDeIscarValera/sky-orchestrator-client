import type { OperationState, Role, Transition, TransitionRequest } from '../backend/backend'
import { changesFleets } from '../fleets/form'

/** The moves a member may ask each state (FR-OPS-02): none while a state runs, none once it is closed. */
export const OFFERED: Readonly<Record<OperationState, readonly Transition[]>> = {
  draft: ['plan', 'cancel'],
  planned: ['prepare', 'cancel'],
  preparing: ['simulate', 'unprepare', 'cancel'],
  simulating: [],
  simulated: ['cancel'],
  ready: ['launch', 'cancel'],
  launching: [],
  in_flight: ['stop'],
  paused: ['stop'],
  returning: [],
  completed: [],
  aborted: [],
  failed: [],
  cancelled: [],
}

/** The states an operation's flight console shows in: its flight is prepared, executing or in the air (FR-CMD-01). */
export const CONSOLE_STATES: readonly OperationState[] = [
  'simulating',
  'launching',
  'in_flight',
  'paused',
  'returning',
]

/** The states whose flights the safety controls command: the aircraft are launching or in the air (FR-CMD-07). */
export const AIRBORNE_STATES: readonly OperationState[] = [
  'launching',
  'in_flight',
  'paused',
  'returning',
]

/** The moves that fly: a pilot of the operation asks each one, and confirms it first (FR-OPS-06, FR-OPS-09, FR-CMD-04). */
export const FLIGHT_MOVES = ['simulate', 'launch', 'stop'] as const

export type FlightMove = (typeof FLIGHT_MOVES)[number]

export function isFlightMove(transition: Transition): transition is FlightMove {
  return (FLIGHT_MOVES as readonly Transition[]).includes(transition)
}

/** Why a member may not ask a move, in the words its tooltip gives (FR-AUT-03, FR-CMD-01). */
export type Withheld = 'Editors only' | 'Pilots only'

/**
 * Why a member may not command an operation's aircraft, or null when they may: an editor or an owner
 * who is a pilot of the operation (FR-CMD-01). The flight moves and the console's commands share it.
 */
export function commandWithheldBy(member: {
  readonly role: Role
  readonly pilot: boolean
}): Withheld | null {
  if (!changesFleets(member.role)) return 'Editors only'
  return member.pilot ? null : 'Pilots only'
}

/** Why a member may not ask this move, or null when they may. An editor or owner asks every move; a flight move needs a pilot too. */
export function withheldBy(
  transition: Transition,
  member: { readonly role: Role; readonly pilot: boolean },
): Withheld | null {
  if (isFlightMove(transition)) return commandWithheldBy(member)
  return changesFleets(member.role) ? null : 'Editors only'
}

/** Whether a request is still being decided: while one is, the operation's moves wait for it (FR-OPS-09). */
export function undecided(request: TransitionRequest | undefined): boolean {
  return request?.status === 'pending' || request?.status === 'running'
}

/** The reasons a request was refused or failed with, as the database gave them; none for any other outcome. */
export function reasonsOf(request: TransitionRequest | undefined): readonly string[] {
  if (request === undefined) return []
  const failed = request.status === 'refused' || request.status === 'failed'
  return failed ? (request.reasons ?? []) : []
}
