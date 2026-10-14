import { useAccount } from '../account/account'
import { ALERT, PILL_TONE } from '../app/styles'
import type { FlightMode, FlightStatus, Operation, PilotCommandVerb } from '../backend/backend'
import { Waiting } from '../fleets/Details'
import { useOrganization } from '../organizations/context'
import { LiveValues } from '../telemetry/LiveValues'
import {
  useCommands,
  useFlights,
  useFlightStates,
  useMembers,
  useOperators,
  useRequestCommand,
  useRequestTransition,
} from './data'
import {
  clampPercent,
  currentFlight,
  newestFirst,
  offersOf,
  resultOf,
  stateOf,
  waypointNumber,
} from './flightConsole'
import { Failure } from './Failure'
import { HoldButton } from './HoldButton'
import {
  COMMAND_STATUS_TONE,
  COMMAND_STATUS_WORDS,
  COMMAND_VERB_WORDS,
  FLIGHT_MODE_TONE,
  FLIGHT_MODE_WORDS,
  FLIGHT_STATUS_TONE,
  FLIGHT_STATUS_WORDS,
  formatPercent,
  requesterWords,
} from './format'
import { commandWithheldBy, withheldBy } from './moves'
import { OperationPill } from './OperationPill'
import { Section } from './Section'
import { uuidV4 } from './uuid'

/**
 * An operation's flight console, shown under its header while it flies (FR-CMD-01 to FR-CMD-06,
 * FR-SAF-04, FR-TEL-02): the mode, the flight's progress, the commands a pilot may send, the aircraft's
 * live values and the commands' feed. A value the stack has not said reads as unavailable, never as zero.
 */
export function FlightConsole({
  operation,
  waypoints,
}: {
  readonly operation: Operation
  /** The waypoints of the operation's stored flight, or null while it cannot be read. */
  readonly waypoints: number | null
}) {
  const { organization } = useOrganization()
  const account = useAccount()
  const flights = useFlights(operation.id)
  const states = useFlightStates(operation.id)
  const operators = useOperators(operation.id)
  const command = useRequestCommand()
  const transition = useRequestTransition()

  if (flights.isError) {
    return <Failure message={flights.error.message} onRetry={() => void flights.refetch()} />
  }
  if (states.isError) {
    return <Failure message={states.error.message} onRetry={() => void states.refetch()} />
  }
  if (operators.isError) {
    return <Failure message={operators.error.message} onRetry={() => void operators.refetch()} />
  }
  if (flights.isPending || states.isPending || operators.isPending) {
    return <Waiting>Loading the flight…</Waiting>
  }

  const flight = currentFlight(flights.data)
  const state = flight === null ? null : stateOf(states.data, flight.id)
  const status: FlightStatus | null = state?.status ?? null
  const pilot = operators.data.some(
    ({ profileId, role }) => profileId === account.userId && role === 'pilot',
  )
  const member = { role: organization.role, pilot }
  const busy = command.isPending || transition.isPending
  const offers = flight === null ? null : offersOf(flight, status, operation.state)
  const offered = offers !== null && Object.values(offers).some(Boolean)

  const send = (verb: PilotCommandVerb) => {
    if (flight !== null) command.mutate({ flightId: flight.id, verb, clientRequestId: uuidV4() })
  }
  const stop = () => {
    transition.mutate({
      operationId: operation.id,
      transition: 'stop',
      clientRequestId: uuidV4(),
    })
  }

  return (
    <section aria-label="Flight console" className="mt-4 flex flex-col gap-4">
      <ModeBanner mode={flight?.mode ?? null} />
      <Progress
        status={status}
        percent={state?.percent ?? null}
        waypoint={waypointNumber(state?.currentWaypointIndex ?? null)}
        waypoints={waypoints}
      />
      {offers !== null && offered && (
        <div role="group" aria-label="Flight commands" className="flex flex-wrap gap-2">
          {offers.pause && (
            <HoldButton
              reason={commandWithheldBy(member)}
              busy={busy}
              onConfirm={() => {
                send('pause')
              }}
            >
              Pause
            </HoldButton>
          )}
          {offers.resume && (
            <HoldButton
              reason={commandWithheldBy(member)}
              busy={busy}
              onConfirm={() => {
                send('recovery')
              }}
            >
              Resume
            </HoldButton>
          )}
          {offers.returnHome && (
            <HoldButton
              tone="danger"
              reason={commandWithheldBy(member)}
              busy={busy}
              onConfirm={() => {
                send('return_home')
              }}
            >
              Return home
            </HoldButton>
          )}
          {offers.stop && (
            <HoldButton
              tone="danger"
              reason={withheldBy('stop', member)}
              busy={busy}
              onConfirm={stop}
            >
              Stop
            </HoldButton>
          )}
          {offers.undo && (
            <HoldButton
              reason={commandWithheldBy(member)}
              busy={busy}
              onConfirm={() => {
                send('undo')
              }}
            >
              Undo
            </HoldButton>
          )}
        </div>
      )}
      {command.isError && (
        <p role="alert" className={ALERT}>
          {command.error.message}
        </p>
      )}
      {transition.isError && (
        <p role="alert" className={ALERT}>
          {transition.error.message}
        </p>
      )}
      {flight !== null && (
        <LiveValues gatewaySn={flight.gatewaySn} aircraftSn={flight.aircraftSn} />
      )}
      <CommandFeed operationId={operation.id} />
    </section>
  )
}

/** The flight's mode, the one word that says whether it is real or simulated (FR-SAF-04). */
function ModeBanner({ mode }: { readonly mode: FlightMode | null }) {
  return (
    <p
      role="status"
      data-mode={mode ?? 'unknown'}
      className={`${PILL_TONE[mode === null ? 'muted' : FLIGHT_MODE_TONE[mode]]} font-heading rounded-xl px-4 py-2 text-center text-lg font-semibold`}
    >
      {mode === null ? 'Mode unknown' : FLIGHT_MODE_WORDS[mode]}
    </p>
  )
}

/** The flight's status, waypoint and progress; each the stack has not said reads as unavailable. */
function Progress({
  status,
  percent,
  waypoint,
  waypoints,
}: {
  readonly status: FlightStatus | null
  readonly percent: number | null
  /** The waypoint it is at, counted from 1 (waypointNumber). */
  readonly waypoint: number | null
  readonly waypoints: number | null
}) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">Status</dt>
        <dd className="justify-self-end">
          {status === null ? (
            <Unavailable />
          ) : (
            <OperationPill tone={FLIGHT_STATUS_TONE[status]}>
              {FLIGHT_STATUS_WORDS[status]}
            </OperationPill>
          )}
        </dd>
        <dt className="text-muted">Waypoint</dt>
        <dd className="text-heading justify-self-end tabular-nums">
          <Figure value={waypoint} /> / <Figure value={waypoints} />
        </dd>
      </dl>
      <div className="flex items-center gap-3">
        {percent === null ? (
          <Unavailable />
        ) : (
          <>
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={clampPercent(percent)}
              className="bg-border h-2 min-w-0 flex-1 overflow-hidden rounded-full"
            >
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${String(clampPercent(percent))}%` }}
              />
            </div>
            <span className="text-heading shrink-0 tabular-nums">{formatPercent(percent)}</span>
          </>
        )}
      </div>
    </div>
  )
}

function Figure({ value }: { readonly value: number | null }) {
  return value === null ? <Unavailable /> : <>{String(value)}</>
}

function Unavailable() {
  return <span className="text-muted">Unavailable</span>
}

/** The operation's commands, newest first: each its verb, its status, who asked it, and a refusal's meaning. */
function CommandFeed({ operationId }: { readonly operationId: string }) {
  const commands = useCommands(operationId)
  const members = useMembers()
  if (commands.isPending) return <Waiting>Loading the commands…</Waiting>
  if (commands.isError) {
    return <Failure message={commands.error.message} onRetry={() => void commands.refetch()} />
  }
  if (commands.data.length === 0) return null
  return (
    <Section title="Commands">
      <ol
        role="log"
        aria-label="Commands"
        className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto text-sm"
      >
        {newestFirst(commands.data).map((intent) => {
          const result = resultOf(intent)
          return (
            <li key={intent.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
              <span className="font-medium">{COMMAND_VERB_WORDS[intent.verb]}</span>
              <OperationPill tone={COMMAND_STATUS_TONE[intent.status]}>
                {COMMAND_STATUS_WORDS[intent.status]}
              </OperationPill>
              <span className="text-muted">
                {requesterWords(intent.requestedBy, members.data ?? [])}
              </span>
              {result !== null && (
                <span className="text-muted min-w-0 break-words">
                  {result.words} · <span className="tabular-nums">{result.code}</span>
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </Section>
  )
}
