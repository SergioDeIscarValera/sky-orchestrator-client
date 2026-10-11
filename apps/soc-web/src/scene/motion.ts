import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(changed: () => void): () => void {
  const query = window.matchMedia(QUERY)
  query.addEventListener('change', changed)
  return () => {
    query.removeEventListener('change', changed)
  }
}

/** Camera flights become cuts when the user asks for less motion (NFR-UX-05). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches)
}
