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
 * selection, a fleet or an aircraft seen on the wire, so a view can be shared on
 * the LAN. A value that does not read is left out rather than refused: a stale
 * link opens the console as it can.
 */
export interface View {
  readonly panel?: Panel
  readonly fleet?: string
  readonly gateway?: string
  readonly aircraft?: string
  /** The selection's form open in the inspector: registering an aircraft, editing a fleet. */
  readonly form?: Form
}

export type Form = 'register' | 'edit'

export type Selection =
  | { readonly kind: 'fleet'; readonly fleetId: string }
  | { readonly kind: 'device'; readonly gatewaySn: string; readonly aircraftSn: string }

const FIELDS = {
  panel: z.enum(PANELS),
  form: z.enum(['register', 'edit']),
  fleet: z.uuid(),
  serial: z.string().check(z.regex(/^[A-Za-z0-9]{1,64}$/)),
}

export function readView(search: Record<string, unknown>): View {
  const view: { panel?: Panel; fleet?: string; gateway?: string; aircraft?: string; form?: Form } =
    {}
  const panel = FIELDS.panel.safeParse(search.panel)
  if (panel.success) view.panel = panel.data
  const fleet = FIELDS.fleet.safeParse(search.fleet)
  const gateway = FIELDS.serial.safeParse(search.gateway)
  const aircraft = FIELDS.serial.safeParse(search.aircraft)
  if (fleet.success) view.fleet = fleet.data
  else if (gateway.success && aircraft.success) {
    view.gateway = gateway.data
    view.aircraft = aircraft.data
  }
  // A form belongs to a selection: alone, it opens nothing.
  const form = FIELDS.form.safeParse(search.form)
  if (form.success && selectionOf(view) !== null) view.form = form.data
  return view
}

export function selectionOf(view: View): Selection | null {
  if (view.fleet !== undefined) return { kind: 'fleet', fleetId: view.fleet }
  if (view.gateway !== undefined && view.aircraft !== undefined) {
    return { kind: 'device', gatewaySn: view.gateway, aircraftSn: view.aircraft }
  }
  return null
}

/** The view with one thing selected, or nothing; the panel stays as it is. */
export function select(view: View, selection: Selection | null): View {
  const { panel } = view
  if (selection === null) return { panel }
  if (selection.kind === 'fleet') return { panel, fleet: selection.fleetId }
  return { panel, gateway: selection.gatewaySn, aircraft: selection.aircraftSn }
}

export function createConsoleRouter(component: FunctionComponent): AnyRouter {
  const root = createRootRoute({ component, validateSearch: readView })
  return createRouter({ routeTree: root })
}

export function useView(): View {
  return useSearch({ strict: false })
}

export function useSelection(): Selection | null {
  return selectionOf(useView())
}

/** The form open for the selection, if any, and how to open or close it. */
export function useForm(): readonly [Form | null, (form: Form | null) => void] {
  const { form } = useView()
  const change = useChangeView()
  const open = useCallback(
    (next: Form | null) => {
      change((view) => ({ ...view, form: next ?? undefined }))
    },
    [change],
  )
  return [form ?? null, open]
}

/** Selects `selection` with its form open: the fleet panel's Register and Edit. */
export function useOpenForm(): (selection: Selection, form: Form) => void {
  const change = useChangeView()
  return useCallback(
    (selection: Selection, form: Form) => {
      change((view) => ({ ...select(view, selection), form }))
    },
    [change],
  )
}

export function useSelect(): (selection: Selection | null) => void {
  const change = useChangeView()
  return useCallback(
    (selection: Selection | null) => {
      change((view) => select(view, selection))
    },
    [change],
  )
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
