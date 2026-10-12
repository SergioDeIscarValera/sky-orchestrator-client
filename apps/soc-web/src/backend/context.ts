import { createContext, use, useSyncExternalStore } from 'react'

import type { Backend } from './backend'
import type { Link } from './link'

export const BackendContext = createContext<Backend | null>(null)

export function useBackend(): Backend {
  const backend = use(BackendContext)
  if (backend === null) throw new Error('useBackend outside a BackendContext')
  return backend
}

/** Whether the console's live topics reach it now (NFR-REL-07). */
export function useLink(): Link {
  const backend = useBackend()
  return useSyncExternalStore(
    (changed) => backend.onLink(changed),
    () => backend.link(),
  )
}
