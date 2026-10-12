import type { AircraftModel, Device, LinkState } from '../backend/backend'
import type { Link } from '../backend/link'

export type Presence = 'online' | 'offline' | 'unknown'

/**
 * A device keeps the last presence its stack reported, so it says something about
 * now only while that stack is connected (FR-LNK-02), and while the console's own
 * link is up: cut off, the console knows the presence as of the cut (NFR-REL-07).
 */
export function presenceOf(device: Device, link: Link = 'up'): Presence {
  if (link === 'down' || device.stack.linkState !== 'connected') return 'unknown'
  return device.online ? 'online' : 'offline'
}

const STACK_SHORT: Readonly<Record<LinkState, string>> = {
  connected: 'Stack connected',
  connecting: 'Stack connecting',
  displaced: 'Stack displaced',
  unreachable: 'Stack unreachable',
}

const STACK_LONG: Readonly<Record<LinkState, string>> = {
  connected: 'connected',
  connecting: 'connecting',
  displaced: 'displaced by another cloud client',
  unreachable: 'unreachable',
}

export function presenceLabel(device: Device, link: Link = 'up'): string {
  switch (presenceOf(device, link)) {
    case 'online':
      return 'Online'
    case 'offline':
      return 'Offline'
    case 'unknown':
      return link === 'down' ? 'Unknown' : STACK_SHORT[device.stack.linkState]
  }
}

export function stackLabel(device: Device): string {
  return `${device.stack.name}, ${STACK_LONG[device.stack.linkState]}`
}

/** Hours and minutes, or seconds under a minute: 5400 is "1 h 30 min". */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${String(hours)} h`)
  if (minutes > 0) parts.push(`${String(minutes)} min`)
  if (hours === 0 && minutes === 0 && rest > 0) parts.push(`${String(rest)} s`)
  return parts.length === 0 ? '0 min' : parts.join(' ')
}

const FIGURE = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })

/** A moment in the organization's time zone, the device's when it has none or an unknown one. */
export function formatMoment(iso: string, timeZone: string | null): string {
  const style = { dateStyle: 'medium', timeStyle: 'short' } as const
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-GB', timeZone === null ? style : { ...style, timeZone })
  } catch {
    format = new Intl.DateTimeFormat('en-GB', style)
  }
  return format.format(new Date(iso))
}

/** One published figure of a model, null when DJI does not publish it, and the page it was read on. */
export interface SpecRow {
  readonly label: string
  readonly value: string | null
  readonly source: string | null
}

const THERMAL: Readonly<Record<AircraftModel['thermal']['capability'], string>> = {
  integrated: 'Integrated',
  payload: 'Through a payload',
  none: 'None',
}

export function specRows(model: AircraftModel): SpecRow[] {
  const figure = (value: number | null, unit: string) =>
    value === null ? null : `${FIGURE.format(value)} ${unit}`
  const row = (label: string, value: string | null, field: string): SpecRow => ({
    label,
    value,
    source: model.sources[field] ?? null,
  })
  const { thermal } = model
  return [
    row(
      'Max horizontal speed',
      figure(model.maxHorizontalSpeedMs, 'm/s'),
      'max_horizontal_speed_ms',
    ),
    row('Max ascent speed', figure(model.maxAscentSpeedMs, 'm/s'), 'max_ascent_speed_ms'),
    row('Max descent speed', figure(model.maxDescentSpeedMs, 'm/s'), 'max_descent_speed_ms'),
    row(
      'Max flight time',
      model.maxFlightTimeS === null ? null : formatDuration(model.maxFlightTimeS),
      'max_flight_time_s',
    ),
    row('Max service ceiling', figure(model.maxServiceCeilingM, 'm'), 'max_service_ceiling_m'),
    row('Max wind resistance', figure(model.maxWindResistanceMs, 'm/s'), 'max_wind_resistance_ms'),
    row('Weight', figure(model.weightG, 'g'), 'weight_g'),
    row('Camera sensor', model.camera.sensor, 'camera.sensor'),
    row('Photo resolution', model.camera.photoResolution, 'camera.photo_resolution'),
    row('Video resolution', model.camera.videoResolution, 'camera.video_resolution'),
    row('Zoom', model.camera.zoom, 'camera.zoom'),
    row(
      'Thermal camera',
      thermal.resolution === null
        ? THERMAL[thermal.capability]
        : `${THERMAL[thermal.capability]}, ${thermal.resolution}`,
      'thermal.capability',
    ),
  ]
}
