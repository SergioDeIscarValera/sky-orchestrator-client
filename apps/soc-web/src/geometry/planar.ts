import { orient2d } from 'robust-predicates'

/**
 * Plane geometry on the local frame (ADR-0009): what the console's generators build
 * with and its previews decide on, the same predicates as libs/soc-geo's
 * `soc_geo.planar`. Points are [east, north] in metres. Every decision rests on one
 * orientation test, Shewchuk's, exact for any floats, so no rounding flips a decision
 * at a boundary; distances are floats, compared with margins of metres. The golden
 * vectors of contracts/geometry/planar.json hold this, the Python and shapely together
 * within 10⁻⁶ m.
 */

export type Point = readonly [number, number]
export type Polygon = readonly Point[]
export type Place = 'inside' | 'boundary' | 'outside'

/**
 * The turn a → b → c, exactly: 1 counter-clockwise, -1 clockwise, 0 straight, with
 * north up as on the local frame. robust-predicates' `orient2d` is Shewchuk's with
 * y down, as on a screen, so its sign is turned here.
 */
export function orientation(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const screen = orient2d(a[0], a[1], b[0], b[1], c[0], c[1])
  return screen < 0 ? 1 : screen > 0 ? -1 : 0
}

function withinBox(p: Point, a: Point, b: Point): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  )
}

/** Whether `p` lies on the closed segment a-b. */
export function onSegment(p: Point, a: Point, b: Point): boolean {
  return orientation(a, b, p) === 0 && withinBox(p, a, b)
}

/** Whether the closed segments a-b and c-d share a point, touching included. */
export function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true
  return (
    (o1 === 0 && withinBox(c, a, b)) ||
    (o2 === 0 && withinBox(d, a, b)) ||
    (o3 === 0 && withinBox(a, c, d)) ||
    (o4 === 0 && withinBox(b, c, d))
  )
}

/** The polygon's edges, the last closing it back to the first vertex. */
export function edges(polygon: Polygon): (readonly [Point, Point])[] {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length] ?? point])
}

/** Neumaier's compensated sum, so a long perimeter or a large area keeps its last digits. */
function sum(values: readonly number[]): number {
  let total = 0
  let compensation = 0
  for (const value of values) {
    const next = total + value
    compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total
    total = next
  }
  return total + compensation
}

/** The shoelace area: positive counter-clockwise, negative clockwise. */
export function signedArea(polygon: Polygon): number {
  return 0.5 * sum(edges(polygon).map(([a, b]) => a[0] * b[1] - b[0] * a[1]))
}

export function perimeter(polygon: Polygon): number {
  return sum(edges(polygon).map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])))
}

/** Why a polygon is not simple, with the edges it is about (FR-GEO-01, FR-GEO-04). */
export interface Problem {
  readonly rule: 'too_few_vertices' | 'zero_length_edge' | 'edges_meet' | 'no_area'
  readonly edges: readonly number[]
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1]

/** Everything that keeps `polygon` from being simple, each with its edges, or none. */
export function problems(polygon: Polygon): Problem[] {
  const count = polygon.length
  if (count < 3) return [{ rule: 'too_few_vertices', edges: [] }]
  const sides = edges(polygon)
  const found: Problem[] = sides.flatMap(([a, b], index) =>
    same(a, b) ? [{ rule: 'zero_length_edge' as const, edges: [index] }] : [],
  )
  for (const [i, [a, b]] of sides.entries()) {
    for (const [j, [c, d]] of sides.entries()) {
      if (j <= i) continue
      if (j === i + 1 || (i === 0 && j === count - 1)) {
        // Neighbours share a vertex; they fail only by doubling back along each other.
        const [shared, mine, theirs] = j === i + 1 ? [b, a, d] : [a, b, c]
        if (
          !same(a, b) &&
          !same(c, d) &&
          orientation(shared, mine, theirs) === 0 &&
          (withinBox(theirs, shared, mine) || withinBox(mine, shared, theirs))
        ) {
          found.push({ rule: 'edges_meet', edges: [i, j] })
        }
        continue
      }
      if (segmentsMeet(a, b, c, d)) found.push({ rule: 'edges_meet', edges: [i, j] })
    }
  }
  const [first, second] = polygon
  if (
    found.length === 0 &&
    first !== undefined &&
    second !== undefined &&
    polygon.slice(2).every((point) => orientation(first, second, point) === 0)
  ) {
    found.push({ rule: 'no_area', edges: [] })
  }
  return found
}

/** Where `p` lies against a simple polygon, decided exactly, its boundary included. */
export function locate(polygon: Polygon, p: Point): Place {
  let winding = 0
  for (const [a, b] of edges(polygon)) {
    if (onSegment(p, a, b)) return 'boundary'
    if (a[1] <= p[1] && p[1] < b[1] && orientation(a, b, p) > 0) winding += 1
    else if (b[1] <= p[1] && p[1] < a[1] && orientation(a, b, p) < 0) winding -= 1
  }
  return winding !== 0 ? 'inside' : 'outside'
}

/** The distance from `p` to the closed segment a-b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const share = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
  return Math.hypot(p[0] - (a[0] + share * dx), p[1] - (a[1] + share * dy))
}

/** The distance between the closed segments a-b and c-d: zero when they meet. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsMeet(a, b, c, d)) return 0
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  )
}

/**
 * How far the leg a-b keeps from the polygon's boundary, all of it inside, or null when
 * any of it is on the boundary or outside. Both ends inside is not enough: a leg across
 * the arms of a U leaves with both its ends in it (ADR-0009), so every edge is tried.
 */
export function legClearance(polygon: Polygon, a: Point, b: Point): number | null {
  if (locate(polygon, a) !== 'inside' || locate(polygon, b) !== 'inside') return null
  const sides = edges(polygon)
  if (sides.some(([c, d]) => segmentsMeet(a, b, c, d))) return null
  return Math.min(...sides.map(([c, d]) => segmentDistance(a, b, c, d)))
}
