import type { Freshness } from '../telemetry/freshness'
import type { TelemetrySample } from '../telemetry/sample'
import { formatMetres } from '../telemetry/format'

/** At most this many rich labels at once; the rest keep their compact disc (FR-SCN-06). */
export const MAX_RICH_LABELS = 20

/**
 * The aircraft that carry a rich label: the selected one, the hovered one, and the
 * alerting ones (stale or lost), in that order, at most MAX_RICH_LABELS.
 */
export function richLabels(
  aircraft: readonly { readonly key: string; readonly freshness: Freshness }[],
  selected: string | null,
  hovered: string | null,
): string[] {
  const present = new Set(aircraft.map(({ key }) => key))
  const ordered = [
    selected,
    hovered,
    ...aircraft.filter(({ freshness }) => freshness !== 'live').map(({ key }) => key),
  ].filter((key): key is string => key !== null && present.has(key))
  return [...new Set(ordered)].slice(0, MAX_RICH_LABELS)
}

/** What a rich label says: the fleet's name, or the aircraft's serial, then its height and battery. */
export function labelLines(
  name: string,
  sample: TelemetrySample,
  freshness: Freshness,
): { readonly title: string; readonly detail: string } {
  const height = formatMetres(sample.heightM) ?? 'no height'
  const battery = sample.batteryPct === null ? 'no battery' : `${String(sample.batteryPct)} %`
  const state = freshness === 'live' ? '' : ` · ${freshness === 'stale' ? 'stale' : 'lost'}`
  return { title: name, detail: `${height} · ${battery}${state}` }
}
