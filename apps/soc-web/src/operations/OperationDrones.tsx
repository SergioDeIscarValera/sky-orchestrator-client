import { ChevronRight } from 'lucide-react'

import { useSelect } from '../app/router'
import { ALERT, CARD, PILL, PILL_TONE, QUIET_BUTTON } from '../app/styles'
import type { Assignment } from '../backend/backend'
import { formatDuration } from '../fleets/format'
import type { Flight } from '../geometry/flight'
import type { Violation } from '../geometry/limits'
import { formatLength } from '../plans/format'
import { useTrack } from '../telemetry/context'
import { useFreshness, type Freshness } from '../telemetry/freshness'
import { formatMetres, modeName } from '../telemetry/format'
import type { Choices } from './definition'
import { OperationPill } from './OperationPill'
import { Section } from './Section'

const FRESHNESS_TONE: Readonly<Record<Freshness, string>> = {
  live: PILL_TONE.good,
  stale: PILL_TONE.caution,
  lost: PILL_TONE.bad,
}

const FRESHNESS_WORDS: Readonly<Record<Freshness, string>> = {
  live: 'Live',
  stale: 'Stale',
  lost: 'Lost',
}

/**
 * The aircraft the operation flies, one card each (FR-OPS-01, FR-OPS-04): its fleet and model, the
 * wayline it flies at its speed with the stored flight's figures and problems, and what it says
 * now, battery, height and mode, live or last known. Its own detail opens from the card.
 */
export function OperationDrones({
  assignment,
  flight,
  problems,
  error,
  outdated,
  choices,
}: {
  /** The operation's one assignment (the MVP's, FR-OPS-01), or null while it has none. */
  readonly assignment: Assignment | null
  readonly flight: Flight | null
  readonly problems: readonly Violation[]
  /** Why the stored flight cannot be read, if it cannot. */
  readonly error: string | null
  /** The definition now makes another flight: the next Save writes it. */
  readonly outdated: boolean
  readonly choices: Choices
}) {
  return (
    <Section title="Drones">
      {assignment === null ? (
        <p className="text-muted mt-2 text-sm">None</p>
      ) : (
        <DroneCard
          assignment={assignment}
          flight={flight}
          problems={problems}
          error={error}
          outdated={outdated}
          choices={choices}
        />
      )}
    </Section>
  )
}

function DroneCard({
  assignment,
  flight,
  problems,
  error,
  outdated,
  choices,
}: {
  readonly assignment: Assignment
  readonly flight: Flight | null
  readonly problems: readonly Violation[]
  readonly error: string | null
  readonly outdated: boolean
  readonly choices: Choices
}) {
  const select = useSelect()
  const fleet = choices.fleets.find(({ id }) => id === assignment.fleetId)
  const model = choices.models.find(({ model: name }) => name === fleet?.model)
  const wayline = choices.waylines.find(({ id }) => id === assignment.waylineId)
  const route = [
    wayline?.name ?? 'Retired wayline',
    assignment.speedMs === null ? null : `${String(assignment.speedMs)} m/s`,
    flight === null ? null : `${String(flight.waypoints.length)} waypoints`,
    flight === null ? null : formatLength(flight.distanceM),
    flight === null ? null : formatDuration(Math.round(flight.durationS)),
  ].filter((part) => part !== null)
  return (
    <article
      aria-label={fleet?.name ?? 'Retired fleet'}
      className={`${CARD} mt-2 flex flex-col gap-2 p-3`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <p className="text-heading min-w-0 truncate text-sm font-semibold">
          {fleet?.name ?? 'Retired fleet'}
        </p>
        {model !== undefined && <p className="text-muted shrink-0 text-xs">{model.displayName}</p>}
      </header>
      <p className="text-muted text-xs tabular-nums">{route.join(' · ')}</p>
      {fleet !== undefined && <Now gatewaySn={fleet.gatewaySn} aircraftSn={fleet.aircraftSn} />}
      {outdated && (
        <p>
          <OperationPill tone="caution">Out of date</OperationPill>
        </p>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {problems.length > 0 && (
        <ul aria-label="Problems" className="flex flex-col gap-2">
          {problems.map((problem, index) => (
            <li key={`${problem.rule}-${String(index)}`} className={ALERT}>
              <p className="font-semibold">
                {problem.rule}
                {problem.waypointIndex === undefined
                  ? ''
                  : ` · waypoint ${String(problem.waypointIndex)}`}
              </p>
              <p>{problem.message}</p>
            </li>
          ))}
        </ul>
      )}
      {fleet !== undefined && (
        <footer className="-mr-2 -mb-1 flex justify-end">
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              select({ kind: 'fleet', fleetId: fleet.id })
            }}
          >
            Open drone
            <ChevronRight size={15} aria-hidden />
          </button>
        </footer>
      )}
    </article>
  )
}

/** What the aircraft says now: live or last known, its battery, height and mode; none if it has not spoken. */
function Now({
  gatewaySn,
  aircraftSn,
}: {
  readonly gatewaySn: string
  readonly aircraftSn: string
}) {
  const track = useTrack(gatewaySn, aircraftSn)
  const { freshness } = useFreshness(track?.latest)
  if (track === undefined || freshness === null) {
    return (
      <p className="text-muted flex items-center gap-2 text-xs">
        <span className={`${PILL} ${PILL_TONE.muted}`}>No sample</span>
      </p>
    )
  }
  const sample = track.latest.sample
  const values = [
    sample.batteryPct === null ? null : `${String(sample.batteryPct)} %`,
    formatMetres(sample.heightM),
    modeName(sample.modeCode),
  ].filter((value) => value !== null)
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`${PILL} ${FRESHNESS_TONE[freshness]}`}>{FRESHNESS_WORDS[freshness]}</span>
      <span className={`${freshness === 'live' ? 'text-heading' : 'text-muted'} tabular-nums`}>
        {values.join(' · ')}
      </span>
    </p>
  )
}
