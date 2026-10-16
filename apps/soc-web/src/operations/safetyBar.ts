import type { Flight, Operation, Operator, Role } from '../backend/backend'
import { changesFleets } from '../fleets/form'
import { AIRBORNE_STATES } from './moves'

/** A flight the safety controls send to, and the operation it flies in (FR-CMD-07). */
export interface BarTarget {
  readonly operationId: string
  readonly flightId: string
}

/** What the safety controls may do now: the flights they send to, and why they may not be held, when they may not. */
export interface BarPlan {
  readonly targets: readonly BarTarget[]
  /** Why the controls may not be held, as their tooltip; null when they may. */
  readonly reason: string | null
}

/** What the controls have read: the operations, and each airborne operation's operators and flights once read. */
export interface BarReads {
  readonly role: Role
  readonly userId: string
  readonly operations: readonly Operation[]
  readonly operators: ReadonlyMap<string, readonly Operator[]>
  readonly flights: ReadonlyMap<string, readonly Flight[]>
  /** Why a read failed, when one did. */
  readonly failure: string | null
}

/** The operations the safety controls command: their aircraft are launching or in the air (FR-CMD-07). */
export function airborneOf(operations: readonly Operation[]): Operation[] {
  return operations.filter(({ state }) => AIRBORNE_STATES.includes(state))
}

/**
 * What the safety controls may do now. An editor or an owner who is a pilot of an airborne operation
 * commands every flight not ended of the operations they pilot, and no other (FR-CMD-01). Until every
 * airborne operation's operators and flights are read, and while a read has failed, nothing is sent:
 * the controls cannot tell which flights to command.
 */
export function barPlan(reads: BarReads): BarPlan {
  if (reads.failure !== null) return { targets: [], reason: reads.failure }
  const airborne = airborneOf(reads.operations)
  if (airborne.length === 0) return { targets: [], reason: 'No flight to command' }
  if (!changesFleets(reads.role)) return { targets: [], reason: 'Editors only' }
  const unread = airborne.some(({ id }) => !reads.operators.has(id) || !reads.flights.has(id))
  if (unread) return { targets: [], reason: 'Reading the operations' }
  const piloted = airborne.filter(({ id }) =>
    (reads.operators.get(id) ?? []).some(
      ({ profileId, role }) => profileId === reads.userId && role === 'pilot',
    ),
  )
  if (piloted.length === 0) return { targets: [], reason: 'Pilots only' }
  const targets = piloted.flatMap(({ id: operationId }) =>
    (reads.flights.get(operationId) ?? [])
      .filter(({ endedAt }) => endedAt === null)
      .map(({ id: flightId }) => ({ operationId, flightId })),
  )
  return targets.length === 0
    ? { targets, reason: 'No flight to command' }
    : { targets, reason: null }
}
