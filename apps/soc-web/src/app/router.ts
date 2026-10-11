import {
  createRootRoute,
  createRouter,
  useNavigate,
  useSearch,
  type AnyRouter,
} from '@tanstack/react-router'
import { useCallback, type FunctionComponent } from 'react'

import { z } from '../schema'
import { PANELS, type Panel } from './destinations'

/**
 * What the console shows lives in the URL (NFR-UX-03): the open panel and the
 * selection, so a view can be shared on the LAN. A value that does not read is
 * left out rather than refused: a stale link opens the console as it can.
 */
export interface View {
  readonly panel?: Panel
  readonly fleet?: string
}

const FIELDS = {
  panel: z.enum(PANELS),
  fleet: z.uuid(),
}

export function readView(search: Record<string, unknown>): View {
  const view: { panel?: Panel; fleet?: string } = {}
  const panel = FIELDS.panel.safeParse(search.panel)
  if (panel.success) view.panel = panel.data
  const fleet = FIELDS.fleet.safeParse(search.fleet)
  if (fleet.success) view.fleet = fleet.data
  return view
}

export function createConsoleRouter(component: FunctionComponent): AnyRouter {
  const root = createRootRoute({ component, validateSearch: readView })
  return createRouter({ routeTree: root })
}

export function useView(): View {
  return useSearch({ strict: false })
}

export function useChangeView(): (change: (view: View) => View) => void {
  const navigate = useNavigate()
  return useCallback(
    (change: (view: View) => View) => {
      void navigate({ to: '.', search: (view: View) => change(view) })
    },
    [navigate],
  )
}
