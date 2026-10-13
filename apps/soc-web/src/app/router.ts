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
 * selection, a fleet, an aircraft seen on the wire, a geofence, a wayline or an operation, so a
 * view can be shared on the LAN. A value that does not read is left out rather than refused: a
 * stale link opens the console as it can.
 */
export interface View {
  readonly panel?: Panel
  readonly fleet?: string
  readonly gateway?: string
  readonly aircraft?: string
  readonly geofence?: string
  readonly wayline?: string
  readonly operation?: string
  /** The selection's form open in the inspector: registering an aircraft, editing a fleet. */
  readonly form?: Form
}

export type Form = 'register' | 'edit'

export type Selection =
  | { readonly kind: 'fleet'; readonly fleetId: string }
  | { readonly kind: 'device'; readonly gatewaySn: string; readonly aircraftSn: string }
  | { readonly kind: 'geofence'; readonly geofenceId: string }
  | { readonly kind: 'wayline'; readonly waylineId: string }
  | { readonly kind: 'operation'; readonly operationId: string }

const FIELDS = {
  panel: z.enum(PANELS),
  form: z.enum(['register', 'edit']),
  fleet: z.uuid(),
  geofence: z.uuid(),
  wayline: z.uuid(),
  operation: z.uuid(),
  serial: z.string().check(z.regex(/^[A-Za-z0-9]{1,64}$/)),
}

export function readView(search: Record<string, unknown>): View {
  const view: {
    panel?: Panel
    fleet?: string
    gateway?: string
    aircraft?: string
    geofence?: string
    wayline?: string
    operation?: string
    form?: Form
  } = {}
  const panel = FIELDS.panel.safeParse(search.panel)
  if (panel.success) view.panel = panel.data
  const fleet = FIELDS.fleet.safeParse(search.fleet)
  const gateway = FIELDS.serial.safeParse(search.gateway)
  const aircraft = FIELDS.serial.safeParse(search.aircraft)
  const geofence = FIELDS.geofence.safeParse(search.geofence)
  const wayline = FIELDS.wayline.safeParse(search.wayline)
  const operation = FIELDS.operation.safeParse(search.operation)
  if (fleet.success) view.fleet = fleet.data
  else if (geofence.success) view.geofence = geofence.data
  else if (wayline.success) view.wayline = wayline.data
  else if (operation.success) view.operation = operation.data
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
  if (view.geofence !== undefined) return { kind: 'geofence', geofenceId: view.geofence }
  if (view.wayline !== undefined) return { kind: 'wayline', waylineId: view.wayline }
  if (view.operation !== undefined) return { kind: 'operation', operationId: view.operation }
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
  if (selection.kind === 'geofence') return { panel, geofence: selection.geofenceId }
  if (selection.kind === 'wayline') return { panel, wayline: selection.waylineId }
  if (selection.kind === 'operation') return { panel, operation: selection.operationId }
  return { panel, gateway: selection.gatewaySn, aircraft: selection.aircraftSn }
}

/**
 * The view with `panel` open, or with none, and nothing selected: the rail and the panel's
 * close use it, so a change of panel drops the selection and its form, and the inspector
 * closes (NFR-UX-03). The inspector's own actions keep the selection and use `useChangeView`.
 */
export function withPanel(panel: Panel | undefined): View {
  return { panel }
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
