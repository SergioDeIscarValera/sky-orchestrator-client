import { createContext, use, useEffect, useState } from 'react'
import { useStore } from 'zustand'

import { aircraftKey } from '../backend/backend'
import { useBackend } from '../backend/context'
import { useOrganization } from '../organizations/context'
import type { TelemetryStore, Track } from './store'

export const TelemetryContext = createContext<TelemetryStore | null>(null)

export function useTelemetryStore(): TelemetryStore {
  const store = use(TelemetryContext)
  if (store === null) throw new Error('useTelemetryStore outside a TelemetryContext')
  return store
}

/** An aircraft's track, or undefined until a sample of it arrives; other aircraft do not re-render it. */
export function useTrack(gatewaySn: string, aircraftSn: string): Track | undefined {
  const key = aircraftKey(gatewaySn, aircraftSn)
  return useStore(useTelemetryStore(), (state) => state.tracks.get(key))
}

/** Fills the store from the open organization's telemetry topic, and only from it (FR-TEL-01). */
export function useLiveTelemetry(store: TelemetryStore): void {
  const backend = useBackend()
  const { organization } = useOrganization()

  useEffect(() => {
    store.getState().clear()
    const stop = backend.onTelemetry(organization.id, (sample) => {
      store.getState().receive(sample, performance.now())
    })
    return () => {
      stop()
      store.getState().clear()
    }
  }, [backend, organization.id, store])
}

/**
 * In development, and in the measurement build of `pnpm measure` (NFR-PERF-06),
 * `?replay` flies a synthetic aircraft around the organization and `?replay=2` two
 * (`replay.ts`); a production build drops this and the replay with it.
 */
export function useReplay(store: TelemetryStore): void {
  const { organization } = useOrganization()
  const { position } = organization
  // Read once, as the console opens: navigating rewrites the search.
  const [wanted] = useState(() => new URLSearchParams(window.location.search).get('replay'))

  useEffect(() => {
    // Literal conditions, so the production build drops the replay and its chunk.
    if (!import.meta.env.DEV && import.meta.env.MODE !== 'measure') return
    if (wanted === null || position === null) return
    let stop: (() => void) | null = null
    let stopped = false
    void import('./replay').then((replay) => {
      if (stopped) return
      stop = replay.startReplay(
        store,
        { latitudeDeg: position.latitude, longitudeDeg: position.longitude },
        replay.replayCount(wanted),
      )
    })
    return () => {
      stopped = true
      stop?.()
    }
  }, [wanted, store, position])
}
