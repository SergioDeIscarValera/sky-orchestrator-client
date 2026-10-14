import type {
  CommandIntent,
  Flight,
  FlightState,
  FlightStatus,
  OperationState,
} from '../backend/backend'
import { OFFERED } from './moves'
import { resultWords } from './results'

/**
 * The flight the console shows: the operation's latest flight that has not ended, the newest prepared,
 * as the database records it (FR-SAF-04). Null while the operation has no flight in the air or prepared.
 */
export function currentFlight(flights: readonly Flight[]): Flight | null {
  let latest: Flight | null = null
  for (const flight of flights) {
    if (flight.endedAt !== null) continue
    if (latest === null || Date.parse(flight.preparedAt) > Date.parse(latest.preparedAt)) {
      latest = flight
    }
  }
  return latest
}

/** A flight's latest progress as the stack reported it, or null while the stack has said nothing of it. */
export function stateOf(states: readonly FlightState[], flightId: string): FlightState | null {
  return states.find((state) => state.flightId === flightId) ?? null
}

/** The commands the console offers a flight, from its status and its operation's state (FR-CMD-02 to FR-CMD-05). */
export interface Offers {
  readonly pause: boolean
  readonly resume: boolean
  readonly returnHome: boolean
  readonly stop: boolean
  readonly undo: boolean
}

/**
 * Pause while the flight is in progress, resume while it is paused, return home once it executes, stop
 * where the operation offers it (moves.ts), and undo only before it executes: its execution is not begun.
 */
export function offersOf(
  flight: Flight,
  status: FlightStatus | null,
  operation: OperationState,
): Offers {
  const executing = flight.executedAt !== null
  return {
    pause: status === 'in_progress',
    resume: status === 'paused',
    returnHome: executing,
    stop: OFFERED[operation].includes('stop'),
    undo: !executing,
  }
}

/** A percent held to a bar's span, 0 to 100. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * The waypoint a flight is at, counted from 1 as the console shows it: DJI's current_waypoint_index
 * counts from 0, so the last of five waypoints reads 5 / 5, not 4 / 5. Null while the stack has not said.
 */
export function waypointNumber(index: number | null): number | null {
  return index === null ? null : index + 1
}

/** The commands newest first, by when each was asked. Commands asked at the same time keep their order. */
export function newestFirst(commands: readonly CommandIntent[]): CommandIntent[] {
  return [...commands].sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
}

/**
 * The result a command's reply carried, as its words and its code (FR-OPS-09, FR-CMD-06). A reply with
 * no code, or the zero of a success, has no result to show.
 */
export function resultOf(
  command: CommandIntent,
): { readonly words: string; readonly code: number } | null {
  if (command.result === null || command.result === 0) return null
  return { words: resultWords(command.verb, command.result), code: command.result }
}
