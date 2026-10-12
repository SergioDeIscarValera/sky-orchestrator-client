// @vitest-environment node
import { aircraftKey } from '../backend/backend'
import { drawnAt, placement, type Drawn } from '../scene/aircraft'
import { SETTINGS } from '../test/render'
import { readRecording, recordings, type RecordedSample } from '../test/recordings'
import { createTelemetryStore, type Track } from './store'

/** How often the replay looks at the scene: a frame at 20 Hz. */
const FRAME_MS = 50

interface Exercised {
  frames: number
  stale: number
  lost: number
  gapsDrawnWhole: number
}

/**
 * Replays `samples` as they arrived, through the console's telemetry store, the wall
 * clock the recording's own and the monotonic clock its arrivals; at every frame,
 * where the scene would draw each aircraft. `look` sees every frame of every aircraft.
 */
interface Frame {
  readonly now: number
  readonly key: string
  readonly track: Track
  readonly drawn: Drawn | null
  /** When the aircraft's latest sample arrived. */
  readonly lastArrival: number
  /** Where the scene's frame is, the recording's first position. */
  readonly farm: { readonly latitudeDeg: number; readonly longitudeDeg: number }
}

function replay(samples: readonly RecordedSample[], look: (frame: Frame) => void): void {
  const first = samples[0]
  if (first === undefined) throw new Error('an empty recording')
  let wall = first.receivedAtMs
  const store = createTelemetryStore(() => wall)
  const origin = samples.find(
    ({ sample }) => sample.latitudeDeg !== null && sample.longitudeDeg !== null,
  )?.sample
  if (origin === undefined) throw new Error('a recording without a position')
  const farm = { latitudeDeg: origin.latitudeDeg ?? 0, longitudeDeg: origin.longitudeDeg ?? 0 }
  const arrivals = new Map<string, number>()
  const end = (samples.at(-1)?.receivedAtMs ?? 0) - first.receivedAtMs + 12_000
  let next = 0
  for (let now = 0; now <= end; now += FRAME_MS) {
    for (let line = samples[next]; line !== undefined; line = samples[next]) {
      const at = line.receivedAtMs - first.receivedAtMs
      if (at > now) break
      wall = line.receivedAtMs
      store.getState().receive(line.sample, at)
      arrivals.set(aircraftKey(line.sample.gatewaySn, line.sample.aircraftSn), at)
      next += 1
    }
    for (const [key, track] of store.getState().tracks) {
      const drawn = drawnAt(track, farm, now, SETTINGS)
      look({ now, key, track, drawn, lastArrival: arrivals.get(key) ?? 0, farm })
    }
  }
}

describe('recorded telemetry, replayed (NFR-TEST-05)', () => {
  const kept = recordings()

  it('keeps at least one recording, each on the contract', () => {
    expect(kept.size).toBeGreaterThan(0)
    for (const samples of kept.values()) expect(samples.length).toBeGreaterThan(0)
  })

  it.each([...kept.keys()])(
    '%s: never backwards, never past the latest, never across a gap, never stale as live',
    (name) => {
      const samples = kept.get(name) ?? []
      const exercised: Exercised = { frames: 0, stale: 0, lost: 0, gapsDrawnWhole: 0 }
      const lastTaken = new Map<string, number>()
      replay(samples, ({ now, key, track, drawn, lastArrival, farm }) => {
        exercised.frames += 1
        // A track never runs backwards (FR-TEL-01).
        const taken = track.latest.sample.takenAtMs
        expect(taken).toBeGreaterThanOrEqual(lastTaken.get(key) ?? -Infinity)
        lastTaken.set(key, taken)
        if (drawn === null) return
        // No sample for a stale threshold is never live (FR-TEL-02, FR-SAF-02).
        if (now - lastArrival >= SETTINGS.telemetryStaleAfterMs) {
          expect(drawn.freshness).not.toBe('live')
        }
        if (drawn.freshness === 'stale') exercised.stale += 1
        if (drawn.freshness === 'lost') exercised.lost += 1
        const latest = placement(farm, track.latest.sample)
        const previous = track.previous === null ? null : placement(farm, track.previous.sample)
        if (latest === null) return
        // Across a gap, drawn where it is (NFR-REL-07).
        const gap =
          track.previous !== null &&
          taken - track.previous.sample.takenAtMs >= SETTINGS.telemetryStaleAfterMs
        if (gap) {
          expect([drawn.placement.x, drawn.placement.z]).toEqual([latest.x, latest.z])
          exercised.gapsDrawnWhole += 1
          return
        }
        // Between the previous sample and the latest, never past it (FR-TEL-02).
        const from = previous ?? latest
        const along = { x: latest.x - from.x, z: latest.z - from.z }
        const length = along.x ** 2 + along.z ** 2
        if (length === 0) return
        const share =
          ((drawn.placement.x - from.x) * along.x + (drawn.placement.z - from.z) * along.z) / length
        expect(share).toBeGreaterThanOrEqual(-1e-9)
        expect(share).toBeLessThanOrEqual(1 + 1e-9)
      })
      expect(exercised.frames).toBeGreaterThan(0)
    },
  )

  it('replays the dock flight with its silence and its 10 s cut, each rule put to the test', () => {
    const samples = kept.get('2026-10-12-dock-flight-and-cut.jsonl')
    if (samples === undefined) throw new Error('the dock flight is not kept')
    // What the recording holds, as its README says: a minute's flight at 5 Hz, a silence
    // when the dock stopped, the second flight with the browser's network cut.
    const gaps = samples
      .slice(1)
      .map(({ receivedAtMs }, index) => receivedAtMs - (samples[index]?.receivedAtMs ?? 0))
      .filter((gap) => gap >= SETTINGS.telemetryStaleAfterMs)
    expect(samples.length).toBeGreaterThanOrEqual(300)
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(9000)
    const exercised: Exercised = { frames: 0, stale: 0, lost: 0, gapsDrawnWhole: 0 }
    replay(samples, ({ track, drawn }) => {
      exercised.frames += 1
      if (drawn?.freshness === 'stale') exercised.stale += 1
      if (drawn?.freshness === 'lost') exercised.lost += 1
      const gap =
        track.previous !== null &&
        track.latest.sample.takenAtMs - track.previous.sample.takenAtMs >=
          SETTINGS.telemetryStaleAfterMs
      if (gap) exercised.gapsDrawnWhole += 1
    })
    expect(exercised.stale).toBeGreaterThan(0)
    expect(exercised.lost).toBeGreaterThan(0)
    expect(exercised.gapsDrawnWhole).toBeGreaterThan(0)
  })

  it('refuses a line off the contract, naming it', () => {
    const line = (sample: unknown, extra = {}) =>
      JSON.stringify({ received_at_ms: 1000, sample, ...extra })
    const good = readRecording(line(validSample()))
    expect(good).toHaveLength(1)
    expect(() =>
      readRecording(`${line(validSample())}\n${line({ stack: 'lab' })}`, 'x.jsonl'),
    ).toThrow('x.jsonl:2: the sample breaks the telemetry contract')
    expect(() => readRecording(line(validSample(), { note: 'hi' }), 'x.jsonl')).toThrow(
      'x.jsonl:1 has note,received_at_ms,sample',
    )
    expect(() =>
      readRecording(JSON.stringify({ received_at_ms: -1, sample: validSample() }), 'x.jsonl'),
    ).toThrow('x.jsonl:1: received_at_ms is not a time')
  })
})

function validSample() {
  return {
    stack: 'lab',
    gateway_sn: 'SOTESTDOCK01',
    aircraft_sn: 'SOTESTUAV001',
    taken_at_ms: 1000,
    sent_at_ms: 1004,
    latitude_deg: 41.6523,
    longitude_deg: -4.7245,
    height_m: 30,
    heading_deg: 0,
    home_distance_m: 0,
    battery_pct: 90,
    satellites: 14,
    gps_quality: 5,
    mode_code: 5,
  }
}
