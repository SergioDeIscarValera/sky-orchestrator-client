import { createContext, use } from 'react'

import type { Backend } from './backend'

export const BackendContext = createContext<Backend | null>(null)

export function useBackend(): Backend {
  const backend = use(BackendContext)
  if (backend === null) throw new Error('useBackend outside a BackendContext')
  return backend
}
