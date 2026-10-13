// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'

import { PILL_TONE } from '../app/styles'
import {
  CHECK_ORDER,
  CHECK_STATE_TONE,
  CHECK_STATE_WORDS,
  CHECK_WORDS,
  COMMAND_STATUS_WORDS,
  COMMAND_VERB_WORDS,
  EVENT_WORDS,
  FLIGHT_STATUS_WORDS,
  REQUEST_TONE,
  REQUEST_WORDS,
  SEVERITY_WORDS,
  STATE_TONE,
  STATE_WORDS,
  TRANSITION_WORDS,
  checkWords,
  eventWords,
  inlineWords,
  isEventKind,
  localClock,
  valueWords,
} from './format'

/** The copy of contracts/events/events.json the console holds, as the database names the kinds (IR-EVT-02). */
const COPY = new URL('../test/contracts/events.json', import.meta.url)
const CONTRACT = new URL('../../../../contracts/events/events.json', import.meta.url)
const REQUIREMENTS = new URL(
  '../../../../docs/requirements/functional-requirements.md',
  import.meta.url,
)

const kindsOf = (path: URL) =>
  Object.keys(
    (JSON.parse(readFileSync(path, 'utf8')) as { kinds: Record<string, unknown> }).kinds,
  ).sort()

/** The checks of FR-OPS-05's table, in order, and the rows that say a check does not block. */
function tableOfChecks(): { ids: string[]; notBlocking: string[] } {
  const section = readFileSync(REQUIREMENTS, 'utf8')
    .split('### FR-OPS-05')[1]
    ?.split('**Acceptance**')[0]
  if (section === undefined) throw new Error('FR-OPS-05 is not in the requirements')
  const rows = [...section.matchAll(/^\| `(PF-[A-Z-]+)` \| (.+) \|$/gm)]
  return {
    ids: rows.map((row) => row[1] ?? ''),
    notBlocking: rows.filter((row) => /not blocking/.test(row[2] ?? '')).map((row) => row[1] ?? ''),
  }
}

describe("an operation's words (FR-OPS-02, FR-OPS-05, FR-LOG-02)", () => {
  it('names each state and gives it a tone', () => {
    expect(STATE_WORDS).toEqual({
      draft: 'Draft',
      planned: 'Planned',
      preparing: 'Preparing',
      simulating: 'Simulating',
      simulated: 'Simulated',
      ready: 'Ready',
      launching: 'Launching',
      in_flight: 'In flight',
      paused: 'Paused',
      returning: 'Returning',
      completed: 'Completed',
      aborted: 'Aborted',
      failed: 'Failed',
      cancelled: 'Cancelled',
    })
    expect(Object.keys(STATE_TONE).sort()).toEqual(Object.keys(STATE_WORDS).sort())
    for (const tone of Object.values(STATE_TONE)) expect(PILL_TONE).toHaveProperty(tone)
  })

  it('names each move a member may ask, and each status a request can have', () => {
    expect(TRANSITION_WORDS).toEqual({
      plan: 'Plan',
      prepare: 'Prepare',
      unprepare: 'Stop preparing',
      simulate: 'Simulate',
      launch: 'Launch',
      stop: 'Stop',
      cancel: 'Cancel',
    })
    expect(REQUEST_WORDS).toEqual({
      pending: 'Pending',
      running: 'Running',
      accepted: 'Accepted',
      refused: 'Refused',
      failed: 'Failed',
      expired: 'Expired',
    })
    expect(Object.keys(REQUEST_TONE).sort()).toEqual(Object.keys(REQUEST_WORDS).sort())
    for (const tone of Object.values(REQUEST_TONE)) expect(PILL_TONE).toHaveProperty(tone)
  })

  it('names the states of a check, with unknown muted and never green', () => {
    expect(CHECK_STATE_WORDS).toEqual({ pass: 'Pass', fail: 'Fail', unknown: 'Unknown' })
    expect(CHECK_STATE_TONE).toEqual({ pass: 'good', fail: 'bad', unknown: 'muted' })
    expect(PILL_TONE[CHECK_STATE_TONE.unknown]).not.toBe(PILL_TONE[CHECK_STATE_TONE.pass])
  })

  it("names every check of FR-OPS-05's table, in the table's order", () => {
    const table = tableOfChecks()
    expect(table.ids).toHaveLength(16)
    expect([...CHECK_ORDER]).toEqual(table.ids)
    expect(Object.keys(CHECK_WORDS).sort()).toEqual([...table.ids].sort())
    for (const id of table.ids) expect(checkWords(id)).not.toBe(id)
  })

  it('names a check the table does not list by its id, so nothing is hidden', () => {
    expect(checkWords('PF-NEW')).toBe('PF-NEW')
  })

  it('names every event kind in the contract, and only those', () => {
    expect(Object.keys(EVENT_WORDS).sort()).toEqual(kindsOf(COPY))
    for (const words of Object.values(EVENT_WORDS)) expect(words.trim()).not.toBe('')
    expect(EVENT_WORDS.took_off).toBe('Took off')
    expect(EVENT_WORDS.geofence_breach).toBe('Geofence breach')
    expect(EVENT_WORDS.command_outcome).toBe('Command answered')
  })

  // contracts/events/events.json lands with feature/database/operations: until then this is skipped.
  it.skipIf(!existsSync(CONTRACT))('keeps the copy equal to contracts/events/events.json', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as unknown
    expect(JSON.parse(readFileSync(COPY, 'utf8'))).toEqual(contract)
  })

  it('reads an event kind it does not know as the database names it', () => {
    expect(isEventKind('took_off')).toBe(true)
    expect(isEventKind('took_on')).toBe(false)
    expect(eventWords('took_on')).toBe('took_on')
  })

  it('names the severities, the command verbs and statuses, and the flight statuses', () => {
    expect(SEVERITY_WORDS).toEqual({
      info: 'Info',
      warning: 'Warning',
      error: 'Error',
      safety: 'Safety',
    })
    expect(COMMAND_VERB_WORDS).toEqual({
      prepare: 'Prepare',
      execute: 'Execute',
      pause: 'Pause',
      recovery: 'Resume',
      return_home: 'Return home',
      undo: 'Undo',
    })
    expect(COMMAND_STATUS_WORDS).toEqual({
      pending: 'Pending',
      sent: 'Sent',
      accepted: 'Accepted',
      refused: 'Refused',
      failed: 'Failed',
      timed_out: 'Timed out',
      expired: 'Expired',
    })
    expect(Object.keys(FLIGHT_STATUS_WORDS)).toHaveLength(9)
    expect(FLIGHT_STATUS_WORDS.in_progress).toBe('In progress')
  })
})

describe("a check's measured value, as words (FR-OPS-04)", () => {
  it('reads each key as its words, with its unit', () => {
    expect(valueWords({ satellites: 14, gps_quality: 5 })).toBe('satellites 14 · GPS quality 5')
    expect(valueWords({ percent: 12 })).toBe('battery 12%')
    expect(valueWords({ distance_m: 12.5 })).toBe('distance 12.5 m')
    expect(valueWords({ clock_offset_ms: 45 })).toBe('clock offset 45 ms')
    expect(valueWords({ arming_remaining_s: 120 })).toBe('arming remaining 120 s')
  })

  it('reads booleans as yes and no, a list as its items, and a null as unknown', () => {
    expect(valueWords({ armed: true, stack_busy: false })).toBe('armed yes · stack busy no')
    expect(valueWords({ problems: ['too high', 'too far'] })).toBe('problems too high; too far')
    expect(valueWords({ link_state: null })).toBe('link state unknown')
  })

  it('shows nothing for a value that measured nothing', () => {
    expect(valueWords(null)).toBeNull()
    expect(valueWords(undefined)).toBeNull()
    expect(valueWords({})).toBeNull()
  })
})

describe("a log entry's inline value (FR-LOG-02, FR-CMD-06)", () => {
  it('shows a state change as the two states in words', () => {
    expect(inlineWords('operation_state_changed', { from: 'ready', to: 'launching' })).toBe(
      'Ready to Launching',
    )
    expect(
      inlineWords('operation_state_changed', { from: 'ready', to: 'unknown_state' }),
    ).toBeNull()
  })

  it('shows a command outcome as its verb and its status', () => {
    expect(inlineWords('command_outcome', { verb: 'pause', status: 'accepted', result: 0 })).toBe(
      'Pause · Accepted',
    )
    expect(inlineWords('command_outcome', { verb: 'pause' })).toBe('Pause')
  })

  it('shows a flight status with its percent when there is one', () => {
    expect(inlineWords('flight_status_changed', { status: 'in_progress', percent: 40 })).toBe(
      'In progress · 40%',
    )
    expect(inlineWords('flight_status_changed', { status: 'ok', percent: null })).toBe('Completed')
  })

  it('shows a breach with the distance outside, in metres', () => {
    expect(inlineWords('geofence_breach', { distance_outside_m: 12.5, height_m: 40 })).toBe(
      '12.5 m outside',
    )
    expect(inlineWords('geofence_breach', {})).toBeNull()
  })

  it('shows nothing for any other kind', () => {
    expect(inlineWords('took_off', { mode_code: 1 })).toBeNull()
    expect(inlineWords('transition_refused', { transition: 'launch', reasons: ['x'] })).toBeNull()
  })
})

describe("a log entry's time (FR-LOG-03)", () => {
  it('reads the local clock as HH:MM:SS', () => {
    expect(localClock(new Date(2026, 9, 11, 9, 5, 3).toISOString())).toBe('09:05:03')
    expect(localClock(new Date(2026, 9, 11, 23, 59, 59).toISOString())).toBe('23:59:59')
  })

  it('does not read an invalid time as a clock', () => {
    expect(localClock('not a time')).toBe('--:--:--')
  })
})
