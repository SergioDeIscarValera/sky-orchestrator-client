import { createStore, type StoreApi } from 'zustand/vanilla'

import { aircraftKey } from '../backend/backend'
import type { TelemetrySample } from './sample'

export interface Received {
  readonly sample: TelemetrySample
  /** When the browser got it, on its monotonic clock (`performance.now()`). */
  readonly receivedAt: number
}

/** An aircraft's latest sample and the one before it, which motion is interpolated between. */
export interface Track {
  readonly latest: Received
  readonly previous: Received | null
}

/** How many kept deliveries the p95 is taken over: the last 600 (NFR-PERF-01). */
const DELIVERY_WINDOW = 600

interface Telemetry {
  readonly tracks: ReadonlyMap<string, Track>
  readonly receive: (sample: TelemetrySample, receivedAt: number) => void
  readonly clear: () => void
  /** The 95th percentile of the kept deliveries in ms, or null before any sample (NFR-PERF-01). */
  readonly deliveryP95: () => number | null
}

export type TelemetryStore = StoreApi<Telemetry>

/**
 * The open organization's live telemetry, one store per console (ADR-0022: no module holds
 * state). A sample the aircraft took no later than the latest one is dropped, so a track
 * never runs backwards (FR-TEL-01). Each kept sample's delivery, `wallClock()` minus its
 * `sentAtMs`, feeds `deliveryP95`. That figure carries the offset between the mini-PC's clock
 * and the browser's, so it is honest only with both on NTP.
 */
export function createTelemetryStore(wallClock: () => number = Date.now): TelemetryStore {
  const deliveries = new Float64Array(DELIVERY_WINDOW)
  let delivered = 0
  return createStore<Telemetry>()((set) => ({
    tracks: new Map(),
    receive: (sample, receivedAt) => {
      set((state) => {
        const key = aircraftKey(sample.gatewaySn, sample.aircraftSn)
        const track = state.tracks.get(key)
        if (track !== undefined && sample.takenAtMs <= track.latest.sample.takenAtMs) return state
        // After the drop above, so a sample the store does not keep is not measured.
        deliveries[delivered % DELIVERY_WINDOW] = wallClock() - sample.sentAtMs
        delivered += 1
        const tracks = new Map(state.tracks)
        tracks.set(key, { latest: { sample, receivedAt }, previous: track?.latest ?? null })
        return { tracks }
      })
    },
    // A switch of organization starts afresh: its figures are its own stacks'.
    clear: () => {
      delivered = 0
      set({ tracks: new Map() })
    },
    deliveryP95: () => {
      const count = Math.min(delivered, DELIVERY_WINDOW)
      if (count === 0) return null
      // Nearest rank, as soc-cloud's latency.py takes it: the value at ceil(fraction * count).
      const ordered = deliveries.slice(0, count).sort((a, b) => a - b)
      return ordered[Math.max(0, Math.ceil(0.95 * count) - 1)] ?? null
    },
  }))
}
