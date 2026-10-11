import { Crosshair, Navigation2 } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { QUIET_BUTTON } from '../app/styles'
import { useCameraCommands } from '../scene/commands'
import { useTrack } from './context'
import { useFreshness, type Freshness } from './freshness'
import {
  batteryLevel,
  formatAge,
  formatCoordinates,
  formatHeading,
  formatMetres,
  modeName,
  type BatteryLevel,
} from './format'
import type { Takeoff } from './store'

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

const BATTERY_TONE: Readonly<Record<BatteryLevel, string>> = {
  ok: 'bg-success',
  low: 'bg-warning',
  critical: 'bg-danger',
}

/** A value the sample lacks: a dash to the eye, unavailable to a screen reader, never zero. */
function Unavailable() {
  return (
    <span className="text-muted">
      <span aria-hidden>—</span>
      <span className="sr-only">Unavailable</span>
    </span>
  )
}

/** One live value as a tile: its name, the figure large, what it is measured from below. */
function Tile({
  label,
  value,
  note,
  children,
}: {
  readonly label: string
  readonly value: ReactNode
  readonly note?: ReactNode
  readonly children?: ReactNode
}) {
  return (
    <div className="bg-page flex min-w-0 flex-col rounded-xl px-3 py-2">
      <dt className="text-muted text-[11px] font-medium tracking-wide uppercase">{label}</dt>
      <dd className="text-heading font-heading flex items-center gap-1.5 truncate text-lg font-semibold tabular-nums">
        {value ?? <Unavailable />}
      </dd>
      {note !== undefined && <dd className="text-muted truncate text-[11px]">{note}</dd>}
      {children}
    </div>
  )
}

/** The battery's level as a bar, in the status colours below its thresholds. */
function BatteryBar({ percent }: { readonly percent: number }) {
  const level = batteryLevel(percent)
  return (
    <dd className="bg-border mt-1 h-1.5 overflow-hidden rounded-full" aria-hidden>
      <div
        data-level={level}
        className={`h-full rounded-full ${BATTERY_TONE[level]}`}
        style={{ width: `${String(Math.min(100, Math.max(0, percent)))}%` }}
      />
    </dd>
  )
}

/** Where the height is measured from; not seen idle, the scene guesses it (ADR-0014). */
function takeoffPoint(takeoff: Takeoff | null): ReactNode {
  if (takeoff === null) return <Unavailable />
  if (takeoff.estimated) {
    return <span className="text-muted">Not seen; the scene assumes its first position</span>
  }
  return formatCoordinates(takeoff.latitudeDeg, takeoff.longitudeDeg)
}

/**
 * What the aircraft last said and how long ago (FR-TEL-02, FR-TEL-03, FR-FLE-04): the
 * figures that matter in flight as tiles, its position and takeoff point below. A value
 * the sample lacks reads as unavailable, never zero; the values Sky Orchestrator does
 * not send yet (DEP-08, DEP-09) are named once, not shown empty.
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
  const heading = useId()

  if (track === undefined || freshness === null || ageMs === null) {
    return (
      <section aria-labelledby={heading} className="mt-5">
        <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
          Live
        </h4>
        <p className="text-muted mt-2 text-sm">No sample since the console opened</p>
      </section>
    )
  }
  const sample = track.latest.sample
  const battery = sample.batteryPct
  return (
    <section aria-labelledby={heading} className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
          Live
        </h4>
        <span
          className={`rounded-pill inline-flex h-6 items-center px-2.5 text-xs font-medium ${TONE[freshness]}`}
        >
          {WORD[freshness]}, {formatAge(ageMs)} ago
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Tile label="Height" value={formatMetres(sample.heightM)} note="above takeoff" />
        <Tile label="Battery" value={battery === null ? null : `${String(battery)} %`}>
          {battery !== null && <BatteryBar percent={battery} />}
        </Tile>
        <Tile
          label="Satellites"
          value={sample.satellites === null ? null : String(sample.satellites)}
          note={sample.gpsQuality === null ? undefined : `quality ${String(sample.gpsQuality)}`}
        />
        <Tile label="Mode" value={modeName(sample.modeCode)} />
        <Tile
          label="Heading"
          value={
            sample.headingDeg === null ? null : (
              <>
                {/* Navigation2 points north unturned, so the turn is the heading itself. */}
                <Navigation2
                  size={15}
                  aria-hidden
                  className="text-muted shrink-0"
                  style={{ transform: `rotate(${String(sample.headingDeg)}deg)` }}
                />
                {formatHeading(sample.headingDeg)}
              </>
            )
          }
        />
        <Tile label="From home" value={formatMetres(sample.homeDistanceM)} />
      </dl>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Position</dt>
        <dd className="text-heading text-right tabular-nums">
          {formatCoordinates(sample.latitudeDeg, sample.longitudeDeg) ?? <Unavailable />}
        </dd>
        <dt className="text-muted">Takeoff point</dt>
        <dd className="text-heading text-right tabular-nums">{takeoffPoint(track.takeoff)}</dd>
      </dl>
      <p className="text-muted mt-2 text-[11px]">
        Speeds, flight time left and link quality show once Sky Orchestrator sends them.
      </p>
    </section>
  )
}

/** Follows the aircraft in the scene, or lets it go; a selection is followed (FR-SCN-05). */
export function FollowButton({ aircraft }: { readonly aircraft: string }) {
  const following = useCameraCommands((state) => state.pinned === aircraft)
  return (
    <button
      type="button"
      aria-pressed={following}
      title={following ? 'The camera keeps this aircraft in view' : 'Keep this aircraft in view'}
      className={`${QUIET_BUTTON} aria-pressed:bg-primary-subtle aria-pressed:text-primary-emphasis`}
      onClick={() => {
        useCameraCommands.getState().pin(following ? null : aircraft)
      }}
    >
      <Crosshair size={16} aria-hidden />
      {following ? 'Following' : 'Follow'}
    </button>
  )
}
