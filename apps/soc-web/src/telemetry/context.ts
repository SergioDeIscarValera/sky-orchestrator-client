import { createContext, use, useEffect } from 'react'
import { useStore } from 'zustand'

import { aircraftKey } from '../backend/backend'
import { useBackend } from '../backend/context'
import { useOrganization } from '../organizations/context'
import type { TelemetryStore, Track } from './store'

export const TelemetryContext = createContext<TelemetryStore | null>(null)

function useTelemetryStore(): TelemetryStore {
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
