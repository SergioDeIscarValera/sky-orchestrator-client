import {
  aircraftKey,
  type Device,
  type Fleet,
  type FleetChanges,
  type FleetDraft,
  type FleetField,
  type Role,
} from '../backend/backend'

/** The fields the fleet form shows; the wire identity is one choice, the flight time two boxes. */
export type FormField =
  'name' | 'model' | 'airframeSerial' | 'controllerSerial' | 'flightTime' | 'aircraft'

/** What the form holds, as typed. */
export interface FleetFormValues {
  readonly name: string
  readonly model: string
  readonly airframeSerial: string
  readonly controllerSerial: string
  readonly hours: string
  readonly minutes: string
  /** The aircraft the fleet flies as, by `aircraftKey`. */
  readonly aircraft: string
}

export type FormErrors = Partial<Record<FormField, string>>

export type ReadForm =
  | { readonly ok: true; readonly draft: FleetDraft }
  | { readonly ok: false; readonly errors: FormErrors }

/** Editors and owners change fleets; a viewer reads them (FR-FLE-03, FR-FLE-05). */
export function changesFleets(role: Role): boolean {
  return role !== 'viewer'
}

export function blankValues(device: Device): FleetFormValues {
  return {
    name: '',
    model: '',
    airframeSerial: '',
    controllerSerial: '',
    hours: '0',
    minutes: '0',
    aircraft: aircraftKey(device.gatewaySn, device.aircraftSn),
  }
}

export function valuesOf(fleet: Fleet): FleetFormValues {
  return {
    name: fleet.name,
    model: fleet.model,
    airframeSerial: fleet.airframeSerial,
    controllerSerial: fleet.controllerSerial ?? '',
    hours: String(Math.floor(fleet.flightTimeBeforeSocS / 3600)),
    minutes: String(Math.floor((fleet.flightTimeBeforeSocS % 3600) / 60)),
    aircraft: aircraftKey(fleet.gatewaySn, fleet.aircraftSn),
  }
}

const WHOLE = /^\d{1,6}$/

/** The same refusals the database's constraints give, before asking it (FR-FLE-03). */
export function readValues(values: FleetFormValues): ReadForm {
  const errors: FormErrors = {}
  const name = values.name.trim()
  const airframeSerial = values.airframeSerial.trim()
  if (name === '') errors.name = 'A fleet needs a name.'
  if (values.model === '') errors.model = "Choose the aircraft's model from the catalogue."
  if (airframeSerial === '') {
    errors.airframeSerial = 'A fleet needs the serial printed on the airframe.'
  }
  const hours = values.hours.trim() === '' ? '0' : values.hours.trim()
  const minutes = values.minutes.trim() === '' ? '0' : values.minutes.trim()
  if (!WHOLE.test(hours) || !WHOLE.test(minutes) || Number(minutes) > 59) {
    errors.flightTime = 'Hours and minutes are whole numbers, the minutes under 60.'
  }
  const [gatewaySn, aircraftSn, ...rest] = values.aircraft.split('/')
  if (gatewaySn === undefined || aircraftSn === undefined || rest.length > 0) {
    errors.aircraft = 'Choose the aircraft on the wire this fleet flies as.'
  }
  if (Object.keys(errors).length > 0 || gatewaySn === undefined || aircraftSn === undefined) {
    return { ok: false, errors }
  }
  const controllerSerial = values.controllerSerial.trim()
  return {
    ok: true,
    draft: {
      name,
      model: values.model,
      airframeSerial,
      controllerSerial: controllerSerial === '' ? null : controllerSerial,
      gatewaySn,
      aircraftSn,
      flightTimeBeforeSocS: Number(hours) * 3600 + Number(minutes) * 60,
    },
  }
}

/** Only what the form changed, the wire identity as a pair, so nothing else is written. */
export function changesFrom(before: FleetDraft, after: FleetDraft): FleetChanges {
  const changes: { -readonly [K in keyof FleetDraft]?: FleetDraft[K] } = {}
  if (after.name !== before.name) changes.name = after.name
  if (after.model !== before.model) changes.model = after.model
  if (after.airframeSerial !== before.airframeSerial) changes.airframeSerial = after.airframeSerial
  if (after.controllerSerial !== before.controllerSerial) {
    changes.controllerSerial = after.controllerSerial
  }
  if (after.flightTimeBeforeSocS !== before.flightTimeBeforeSocS) {
    changes.flightTimeBeforeSocS = after.flightTimeBeforeSocS
  }
  if (after.gatewaySn !== before.gatewaySn || after.aircraftSn !== before.aircraftSn) {
    changes.gatewaySn = after.gatewaySn
    changes.aircraftSn = after.aircraftSn
  }
  return changes
}

/** Where on the form a field the database refused is shown. */
export function formFieldOf(field: FleetField | null): FormField | null {
  switch (field) {
    case null:
      return null
    case 'gatewaySn':
    case 'aircraftSn':
      return 'aircraft'
    case 'flightTimeBeforeSocS':
      return 'flightTime'
    default:
      return field
  }
}
