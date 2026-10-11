import { Details } from '../fleets/Details'
import { useTrack } from './context'
import { useFreshness, type Freshness } from './freshness'
import { formatAge, formatCoordinates, formatHeading, formatMetres, modeName } from './format'

const TONE: Readonly<Record<Freshness, string>> = {
  live: 'bg-success-subtle text-success-emphasis',
  stale: 'bg-warning-subtle text-warning-emphasis',
  lost: 'bg-danger-subtle text-danger-emphasis',
}

const WORD: Readonly<Record<Freshness, string>> = {
  live: 'Live',
  stale: 'Stale',
  lost: 'Lost',
}

function unavailable(value: string | null) {
  return value ?? <span className="text-muted">Unavailable</span>
}

/**
 * What the aircraft last said and how long ago (FR-TEL-02, FR-TEL-03, FR-FLE-04). A value
 * the sample lacks reads as unavailable, never zero; so do the values Sky Orchestrator does
 * not send yet (DEP-08, DEP-09).
 */
export function LiveValues({
  gatewaySn,
  aircraftSn,
}: {
  readonly gatewaySn: string
  readonly aircraftSn: string
}) {
  const track = useTrack(gatewaySn, aircraftSn)
  const { freshness, ageMs } = useFreshness(track?.latest.receivedAt ?? null)

  if (track === undefined || freshness === null || ageMs === null) {
    return <Details title="Live" rows={[['Telemetry', 'No sample since the console opened']]} />
  }
  const sample = track.latest.sample
  return (
    <Details
      title="Live"
      aside={
        <span
          className={`rounded-pill inline-flex h-6 items-center px-2.5 text-xs font-medium tracking-normal normal-case ${TONE[freshness]}`}
        >
          {WORD[freshness]}, {formatAge(ageMs)} ago
        </span>
      }
      rows={[
        ['Position', unavailable(formatCoordinates(sample.latitudeDeg, sample.longitudeDeg))],
        ['Height above takeoff', unavailable(formatMetres(sample.heightM))],
        ['Heading', unavailable(formatHeading(sample.headingDeg))],
        ['Distance from home', unavailable(formatMetres(sample.homeDistanceM))],
        [
          'Battery',
          unavailable(sample.batteryPct === null ? null : `${String(sample.batteryPct)} %`),
        ],
        ['Satellites', unavailable(sample.satellites === null ? null : String(sample.satellites))],
        [
          'Positioning quality',
          unavailable(sample.gpsQuality === null ? null : String(sample.gpsQuality)),
        ],
        ['Flight mode', unavailable(modeName(sample.modeCode))],
        ['Horizontal speed', unavailable(null)],
        ['Vertical speed', unavailable(null)],
        ['Flight time left', unavailable(null)],
        ['Link quality', unavailable(null)],
      ]}
    />
  )
}
