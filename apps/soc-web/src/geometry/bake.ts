import { circlePoints } from './circle'
import { cover } from './grid'
import type { Point } from './planar'
import { eastNorth, geodeticAt, type Geodetic } from './projection'
import { distanceM } from './sphere'

/**
 * The bake (FR-WAY-07, ADR-0009): a wayline's takeoff point and drawn primitives turned
 * into its waypoints in the order flown, each with its height above the takeoff. Routes
 * keep the order drawn; circles keep their direction and enter where the transit is
 * shortest; grids keep their back and forth from whichever corner shortens it; points of
 * interest are visited once each in the order that does. Units are ordered exactly by
 * Held-Karp up to EXACT_UNITS, above that by nearest neighbour improved by 2-opt. Points
 * closer than MERGE_M merge. A wayline is geometry: the operation that flies it gives its
 * speed, its climb and its finish, splits a leg longer than its stack allows, and judges it
 * against its envelope and geofence (flight.ts). The same design always bakes the same.
 */

export interface DesignPoint extends Geodetic {
  readonly heightM?: number
}

export type Primitive =
  | { readonly kind: 'route'; readonly points: readonly DesignPoint[] }
  | { readonly kind: 'points'; readonly points: readonly DesignPoint[] }
  | {
      readonly kind: 'circle'
      readonly centre: Geodetic
      readonly radiusM: number
      readonly clockwise: boolean
      readonly startBearingDeg: number
      readonly heightM?: number
    }
  | {
      readonly kind: 'grid'
      readonly area: readonly Geodetic[]
      readonly lineSpacingM: number
      readonly pointSpacingM: number
      readonly angleDeg?: number
      readonly heightM?: number
    }

export interface Design {
  readonly takeoff: Geodetic
  /** Above the takeoff point, for every point that gives none of its own (FR-WAY-06). */
  readonly defaultHeightM: number
  readonly primitives: readonly Primitive[]
}

export interface BakeSettings {
  /** The organization's position: the local frame's origin (ADR-0014). */
  readonly origin: Geodetic
  /** The console's `max_arc_spacing_m`, for circles. */
  readonly maxArcSpacingM: number
}

export interface BakedWaypoint extends Geodetic {
  readonly index: number
  readonly heightM: number
}

export interface Baked {
  readonly waypoints: readonly BakedWaypoint[]
  /** From the takeoff point through every waypoint, in Sky Orchestrator's metric. */
  readonly distanceM: number
}

/**
 * The version of this bake, saved with every wayline it bakes (IR-WAY-01): a change to
 * how it orders or merges bumps it, so a saved wayline says what made it.
 */
export const BAKE_VERSION = '2.0.0'

/** Points closer than this merge into the first of them (FR-WAY-07). */
export const MERGE_M = 0.5
/** Up to this many units the order is searched exactly (ADR-0009). */
export const EXACT_UNITS = 13

interface Stop {
  readonly at: Point
  readonly heightM: number
}

/** One way to fly a unit: its stops in order. */
type Variant = readonly Stop[]

/** A unit of the design the order is chosen between, with the ways it may be flown. */
interface Unit {
  readonly variants: readonly Variant[]
}

const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1])

function unitsOf(design: Design, settings: BakeSettings): Unit[] {
  const local = (point: Geodetic): Point => {
    const placed = eastNorth(settings.origin, point)
    return [placed.eastM, placed.northM]
  }
  const height = (own?: number) => own ?? design.defaultHeightM
  return design.primitives.flatMap((primitive): Unit[] => {
    switch (primitive.kind) {
      case 'route':
        return [
          {
            variants: [primitive.points.map((p) => ({ at: local(p), heightM: height(p.heightM) }))],
          },
        ]
      case 'points':
        return primitive.points.map((p) => ({
          variants: [[{ at: local(p), heightM: height(p.heightM) }]],
        }))
      case 'circle': {
        const ring = circlePoints(settings.origin, primitive, settings.maxArcSpacingM)
          .slice(0, -1)
          .map((p) => ({ at: local(p), heightM: height(primitive.heightM) }))
        // Four ways in, a quarter turn apart, each closing back where it entered.
        const entries = [
          ...new Set([0, 1, 2, 3].map((k) => Math.round((k * ring.length) / 4) % ring.length)),
        ]
        return [
          {
            variants: entries.map((entry) => {
              const turned = [...ring.slice(entry), ...ring.slice(0, entry)]
              const back = turned[0]
              return back === undefined ? turned : [...turned, back]
            }),
          },
        ]
      }
      case 'grid': {
        const { lines } = cover({
          area: primitive.area.map(local),
          lineSpacingM: primitive.lineSpacingM,
          pointSpacingM: primitive.pointSpacingM,
          ...(primitive.angleDeg === undefined ? {} : { angleDeg: primitive.angleDeg }),
        })
        const stops = (ordered: readonly (readonly Point[])[]) =>
          ordered.flat().map((at) => ({ at, heightM: height(primitive.heightM) }))
        const mirrored = lines.map((line) => [...line].reverse())
        return [
          {
            variants: [
              stops(lines),
              stops([...lines].reverse()),
              stops(mirrored),
              stops([...mirrored].reverse()),
            ],
          },
        ]
      }
    }
  })
}

const entryOf = (variant: Variant): Point => variant[0]?.at ?? [0, 0]
const exitOf = (variant: Variant): Point => variant.at(-1)?.at ?? [0, 0]

/** A unit's way flown from `from` that enters nearest, the earliest of equals. */
function nearestVariant(unit: Unit, from: Point): number {
  let best = 0
  unit.variants.forEach((variant, index) => {
    const here = distance(from, entryOf(variant))
    if (here < distance(from, entryOf(unit.variants[best] ?? variant))) best = index
  })
  return best
}

interface Choice {
  readonly unit: number
  readonly variant: number
}

/** The transit of flying the units in this order and way, from the takeoff. */
function transit(units: readonly Unit[], order: readonly Choice[], start: Point): number {
  let at = start
  let total = 0
  for (const { unit, variant } of order) {
    const way = units[unit]?.variants[variant] ?? []
    total += distance(at, entryOf(way))
    at = exitOf(way)
  }
  return total
}

/** Held-Karp over the units and their ways: the order of least transit, exactly. */
function exactOrder(units: readonly Unit[], start: Point): Choice[] {
  const states = units.flatMap((unit, u) => unit.variants.map((_, v) => ({ unit: u, variant: v })))
  const ways = states.map(({ unit, variant }) => units[unit]?.variants[variant] ?? [])
  const size = states.length
  const full = (1 << units.length) - 1
  // value[mask * size + state]: the least transit visiting `mask`, ending flying `state`.
  const value = new Float64Array((full + 1) * size).fill(Infinity)
  const before = new Int32Array((full + 1) * size).fill(-1)
  for (const [state, { unit }] of states.entries()) {
    value[(1 << unit) * size + state] = distance(start, entryOf(ways[state] ?? []))
  }
  for (let mask = 1; mask <= full; mask += 1) {
    for (let state = 0; state < size; state += 1) {
      const here = value[mask * size + state] ?? Infinity
      if (here === Infinity) continue
      const exit = exitOf(ways[state] ?? [])
      for (let next = 0; next < size; next += 1) {
        const unit = states[next]?.unit ?? 0
        if (mask & (1 << unit)) continue
        const at = (mask | (1 << unit)) * size + next
        const candidate = here + distance(exit, entryOf(ways[next] ?? []))
        if (candidate < (value[at] ?? Infinity) - 1e-9) {
          value[at] = candidate
          before[at] = mask * size + state
        }
      }
    }
  }
  let best = -1
  for (let state = 0; state < size; state += 1) {
    const at = full * size + state
    if (best === -1 || (value[at] ?? Infinity) < (value[best] ?? Infinity) - 1e-9) best = at
  }
  const order: Choice[] = []
  for (let at = best; at !== -1; at = before[at] ?? -1) {
    const choice = states[at % size]
    if (choice !== undefined) order.unshift(choice)
  }
  return order
}

/** Each unit's way, the nearest entry from the exit before it, along `units` in order. */
function bestWays(units: readonly Unit[], sequence: readonly number[], start: Point): Choice[] {
  let at = start
  return sequence.map((unit) => {
    const variant = nearestVariant(units[unit] ?? { variants: [] }, at)
    at = exitOf(units[unit]?.variants[variant] ?? [])
    return { unit, variant }
  })
}

/** Nearest neighbour, then 2-opt over the units, each way chosen anew after each move. */
function heuristicOrder(units: readonly Unit[], start: Point): Choice[] {
  const left = new Set(units.map((_, index) => index))
  const sequence: number[] = []
  let at = start
  while (left.size > 0) {
    let best = -1
    let bestDistance = Infinity
    for (const unit of left) {
      const way = units[unit]?.variants[nearestVariant(units[unit] ?? { variants: [] }, at)] ?? []
      const here = distance(at, entryOf(way))
      if (here < bestDistance - 1e-9) {
        best = unit
        bestDistance = here
      }
    }
    left.delete(best)
    sequence.push(best)
    at = exitOf(units[best]?.variants[nearestVariant(units[best] ?? { variants: [] }, at)] ?? [])
  }
  let order = bestWays(units, sequence, start)
  let length = transit(units, order, start)
  for (let improved = true; improved;) {
    improved = false
    for (let i = 0; i < sequence.length - 1; i += 1) {
      for (let j = i + 1; j < sequence.length; j += 1) {
        const candidate = [
          ...sequence.slice(0, i),
          ...sequence.slice(i, j + 1).reverse(),
          ...sequence.slice(j + 1),
        ]
        const ways = bestWays(units, candidate, start)
        const candidateLength = transit(units, ways, start)
        if (candidateLength < length - 1e-9) {
          sequence.splice(0, sequence.length, ...candidate)
          order = ways
          length = candidateLength
          improved = true
        }
      }
    }
  }
  return order
}

/**
 * Stops closer than MERGE_M to the one kept before them go into it. The takeoff is not
 * one: a waypoint right above it is where the aircraft climbs to.
 */
function merged(stops: readonly Stop[]): Stop[] {
  const kept: Stop[] = []
  for (const stop of stops) {
    const last = kept.at(-1)
    if (last !== undefined && distance(last.at, stop.at) < MERGE_M) continue
    kept.push(stop)
  }
  return kept
}

/** The design baked into its waypoints in the order flown, and their distance. */
export function bake(design: Design, settings: BakeSettings): Baked {
  const takeoffPlaced = eastNorth(settings.origin, design.takeoff)
  const start: Point = [takeoffPlaced.eastM, takeoffPlaced.northM]
  const units = unitsOf(design, settings).filter((unit) => (unit.variants[0]?.length ?? 0) > 0)
  const order =
    units.length <= EXACT_UNITS ? exactOrder(units, start) : heuristicOrder(units, start)
  const flown = order.flatMap(({ unit, variant }) => units[unit]?.variants[variant] ?? [])
  const waypoints = merged(flown).map((stop, index): BakedWaypoint => {
    const place = geodeticAt(settings.origin, { eastM: stop.at[0], northM: stop.at[1] })
    return { index, ...place, heightM: stop.heightM }
  })
  return { waypoints, distanceM: pathLengthM(design.takeoff, waypoints) }
}

/** From `from` through every point in order, in Sky Orchestrator's metric. */
export function pathLengthM(from: Geodetic, through: readonly Geodetic[]): number {
  let previous = from
  let total = 0
  for (const point of through) {
    total += distanceM(previous, point)
    previous = point
  }
  return total
}
