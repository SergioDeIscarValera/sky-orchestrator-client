import type { Selection } from '../app/router'
import { aircraftKey, type AircraftModel, type Device, type Fleet } from '../backend/backend'

/** At most this many results; a longer list is refined, not scrolled. */
export const MAX_FOUND = 8

/** One thing the search can select, as its result reads. */
export interface Found {
  /** Unique among the results. */
  readonly key: string
  readonly selection: Selection
  /** The aircraft it flies as, by `aircraftKey`, for its colour. */
  readonly aircraft: string
  readonly title: string
  readonly detail: string
  readonly kind: 'Fleet' | 'Aircraft'
}

/** A result and the words it is found by, its title first. */
export interface Searchable {
  readonly found: Found
  readonly words: readonly string[]
}

/** Lower case, without accents, one space between words: `Peñas  Altas` is found by `penas altas`. */
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * What the search can select in the open organization: its fleets, by name, model
 * and serials, then the aircraft its stacks announced that fly in no fleet, by serial,
 * gateway and stack, as the fleet panel lists them.
 */
export function searchables(
  fleets: readonly Fleet[],
  devices: readonly Device[],
  models: readonly AircraftModel[],
): Searchable[] {
  const modelName = (model: string) =>
    models.find(({ model: key }) => key === model)?.displayName ?? model
  const registered = new Set(fleets.map((fleet) => aircraftKey(fleet.gatewaySn, fleet.aircraftSn)))
  const byFleet = [...fleets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((fleet) => ({
      found: {
        key: `fleet:${fleet.id}`,
        selection: { kind: 'fleet', fleetId: fleet.id } as const,
        aircraft: aircraftKey(fleet.gatewaySn, fleet.aircraftSn),
        title: fleet.name,
        detail: `${modelName(fleet.model)} · ${fleet.aircraftSn}`,
        kind: 'Fleet' as const,
      },
      words: [
        fleet.name,
        modelName(fleet.model),
        fleet.model,
        fleet.aircraftSn,
        fleet.airframeSerial,
        ...(fleet.controllerSerial === null ? [] : [fleet.controllerSerial]),
        fleet.gatewaySn,
      ],
    }))
  const byDevice = devices
    .filter((device) => !registered.has(aircraftKey(device.gatewaySn, device.aircraftSn)))
    .sort((a, b) => a.aircraftSn.localeCompare(b.aircraftSn))
    .map((device) => ({
      found: {
        key: `device:${aircraftKey(device.gatewaySn, device.aircraftSn)}`,
        selection: {
          kind: 'device',
          gatewaySn: device.gatewaySn,
          aircraftSn: device.aircraftSn,
        } as const,
        aircraft: aircraftKey(device.gatewaySn, device.aircraftSn),
        title: device.aircraftSn,
        detail: `Not registered · via ${device.stack.name}`,
        kind: 'Aircraft' as const,
      },
      words: [device.aircraftSn, device.gatewaySn, device.stack.name],
    }))
  return [...byFleet, ...byDevice].map(({ found, words }) => ({
    found,
    words: words.map(normalise),
  }))
}

/**
 * How well `query` names an entry, lower is better, or null when some word of the
 * query is in none of its words: the whole query as one of its words, then as the
 * start of one or of a part of one, then inside one, then spread over several.
 */
export function rank(words: readonly string[], query: string): number | null {
  const parts = query.split(/\s+/).filter((part) => part !== '')
  if (!parts.every((part) => words.some((word) => word.includes(part)))) return null
  if (words.some((word) => word === query)) return 0
  if (words.some((word) => word.startsWith(query) || word.includes(` ${query}`))) return 1
  if (words.some((word) => word.includes(query))) return 2
  return 3
}

/**
 * The entries `query` finds, best first, the fleets before the aircraft at the same
 * rank, then in the order given; with no query, every entry in that order. Never
 * more than `MAX_FOUND`.
 */
export function search(entries: readonly Searchable[], query: string): Found[] {
  const wanted = normalise(query)
  if (wanted === '') return entries.slice(0, MAX_FOUND).map(({ found }) => found)
  return entries
    .map((entry, order) => ({ entry, order, rank: rank(entry.words, wanted) }))
    .filter((ranked): ranked is typeof ranked & { rank: number } => ranked.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_FOUND)
    .map(({ entry }) => entry.found)
}

const LETTERS = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * `title` cut where `query` is found in it, accents and case aside, so the result
 * can mark it: [before, found, after], or the title alone when it is not there.
 */
export function marked(title: string, query: string): readonly string[] {
  const wanted = normalise(query)
  if (wanted === '') return [title]
  // Each letter of the title, accents and all, normalised on its own, so an index of
  // the normalised title maps back to the letter it came from.
  const characters = Array.from(LETTERS.segment(title), ({ segment }) => segment)
  const plain = characters.map((letter) =>
    /\s/.test(letter) ? ' ' : letter.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
  )
  const from = plain.flatMap((letters, index) => Array.from(letters, () => index))
  const at = plain.join('').indexOf(wanted)
  if (at < 0) return [title]
  const start = from[at] ?? 0
  const end = (from[at + wanted.length - 1] ?? start) + 1
  return [
    characters.slice(0, start).join(''),
    characters.slice(start, end).join(''),
    characters.slice(end).join(''),
  ]
}
