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

interface Telemetry {
  readonly tracks: ReadonlyMap<string, Track>
  readonly receive: (sample: TelemetrySample, receivedAt: number) => void
  readonly clear: () => void
}

export type TelemetryStore = StoreApi<Telemetry>

/**
 * The open organization's live telemetry, one store per console (ADR-0022: no module holds
 * state). A sample the aircraft took no later than the latest one is dropped, so a track
 * never runs backwards (FR-TEL-01).
 */
export function createTelemetryStore(): TelemetryStore {
  return createStore<Telemetry>()((set) => ({
    tracks: new Map(),
    receive: (sample, receivedAt) => {
      set((state) => {
        const key = aircraftKey(sample.gatewaySn, sample.aircraftSn)
        const track = state.tracks.get(key)
        if (track !== undefined && sample.takenAtMs <= track.latest.sample.takenAtMs) return state
        const tracks = new Map(state.tracks)
        tracks.set(key, { latest: { sample, receivedAt }, previous: track?.latest ?? null })
        return { tracks }
      })
    },
    clear: () => {
      set({ tracks: new Map() })
    },
  }))
}
