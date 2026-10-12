import { orientation, type Point } from './planar'

/**
 * The geofence generated around an operation (FR-GEO-03, ADR-0009): the convex hull of
 * its takeoff points, reference points and waypoints, grown by the margin with lines
 * tangent to the margin's circle at every corner, so the polygon holds every point of the
 * hull at the margin or more; a hull with more corners than the polygon may have is
 * first enlarged, never cut. On the local frame, [east, north] in metres.
 */

/** The convex hull of `points`, counter-clockwise, its collinear points dropped. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const unique = sorted.filter(
    (point, index) =>
      index === 0 || point[0] !== sorted[index - 1]?.[0] || point[1] !== sorted[index - 1]?.[1],
  )
  if (unique.length < 3) return unique
  const half = (ordered: readonly Point[]) => {
    const chain: Point[] = []
    for (const point of ordered) {
      while (chain.length >= 2) {
        const [a, b] = [chain.at(-2), chain.at(-1)]
        if (a === undefined || b === undefined || orientation(a, b, point) > 0) break
        chain.pop()
      }
      chain.push(point)
    }
    return chain.slice(0, -1)
  }
  const hull = [...half(unique), ...half([...unique].reverse())]
  return hull.length < 3 ? unique.slice(0, 1).concat(unique.slice(-1)) : hull
}

const angleOf = (x: number, y: number) => Math.atan2(y, x)

/** The outward normal's angle of the edge a → b of a counter-clockwise polygon. */
function outwardAngle(a: Point, b: Point): number {
  return angleOf(b[1] - a[1], -(b[0] - a[0]))
}

/**
 * Where the line through a → b, carried on past b, meets the line through d → c,
 * carried on past c; null when they are parallel or meet anywhere else.
 */
function meetingAhead(a: Point, b: Point, d: Point, c: Point): Point | null {
  const r: Point = [b[0] - a[0], b[1] - a[1]]
  const s: Point = [c[0] - d[0], c[1] - d[1]]
  const cross = r[0] * s[1] - r[1] * s[0]
  if (cross === 0) return null
  const t = ((d[0] - a[0]) * s[1] - (d[1] - a[1]) * s[0]) / cross
  const u = ((d[0] - a[0]) * r[1] - (d[1] - a[1]) * r[0]) / cross
  if (t <= 1 || u <= 1) return null
  return [a[0] + t * r[0], a[1] + t * r[1]]
}

/**
 * `hull` with at most `corners` corners, still holding it: each step removes the edge
 * whose two neighbours, extended until they meet, add the least area. An edge can go
 * only where its neighbours meet beyond it, which a convex polygon of more than four
 * corners always offers.
 */
export function enlargedTo(hull: readonly Point[], corners: number): Point[] {
  let polygon = [...hull]
  while (polygon.length > corners && polygon.length > 3) {
    let best: { index: number; meet: Point; area: number } | null = null
    const count = polygon.length
    for (let index = 0; index < count; index += 1) {
      const before = polygon[(index - 1 + count) % count]
      const start = polygon[index]
      const end = polygon[(index + 1) % count]
      const after = polygon[(index + 2) % count]
      if (before === undefined || start === undefined || end === undefined || after === undefined) {
        continue
      }
      // The neighbours, carried on past the edge's ends, must meet beyond it.
      const meet = meetingAhead(before, start, after, end)
      if (meet === null || orientation(start, end, meet) >= 0) continue
      const area =
        Math.abs(
          (end[0] - start[0]) * (meet[1] - start[1]) - (end[1] - start[1]) * (meet[0] - start[0]),
        ) / 2
      if (best === null || area < best.area) best = { index, meet, area }
    }
    if (best === null) break
    const { index, meet } = best
    const next = (index + 1) % count
    polygon = polygon.flatMap((point, at) => (at === index ? [meet] : at === next ? [] : [point]))
  }
  return polygon
}

/** How far a corner's arc turns, from one outward normal to the next, in (0, 2π]. */
function turnOf(fromAngle: number, toAngle: number): number {
  const turn = (((toAngle - fromAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return turn === 0 ? 2 * Math.PI : turn
}

/** No corner's tangents need be closer than this to keep the polygon tight. */
const FINEST_STEP_RAD = (10 * Math.PI) / 180

/**
 * The polygon holding `hull` grown by `marginM`, with at most `maxVertices` vertices:
 * at each corner, lines tangent to the margin's circle round it, as many as the
 * vertices allow, the corner with the widest step taking the next one.
 */
export function grownBy(hull: readonly Point[], marginM: number, maxVertices: number): Point[] {
  const base = enlargedTo(hull, maxVertices)
  const count = base.length
  const arcs = base.map((corner, index) => {
    if (count === 1) return { corner, from: 0, turn: 2 * Math.PI }
    const before = base[(index - 1 + count) % count] ?? corner
    const after = base[(index + 1) % count] ?? corner
    const from = outwardAngle(before, corner)
    return { corner, from, turn: turnOf(from, outwardAngle(corner, after)) }
  })
  // A step must stay under half a turn for its tangents to meet.
  const steps = arcs.map(({ turn }) => Math.max(1, Math.floor(turn / Math.PI) + 1))
  const wanted = arcs.map(({ turn }, index) =>
    Math.max(steps[index] ?? 1, Math.ceil(turn / FINEST_STEP_RAD)),
  )
  let spare = maxVertices - steps.reduce((total, step) => total + step, 0)
  while (spare > 0) {
    let widest = -1
    for (const [index, { turn }] of arcs.entries()) {
      const step = steps[index] ?? 1
      if (step >= (wanted[index] ?? 1)) continue
      if (widest === -1 || turn / step > (arcs[widest]?.turn ?? 0) / (steps[widest] ?? 1)) {
        widest = index
      }
    }
    if (widest === -1) break
    steps[widest] = (steps[widest] ?? 1) + 1
    spare -= 1
  }
  return arcs.flatMap(({ corner, from, turn }, index) => {
    const step = turn / (steps[index] ?? 1)
    const reach = marginM / Math.cos(step / 2)
    return Array.from({ length: steps[index] ?? 1 }, (_, j): Point => {
      const angle = from + (j + 0.5) * step
      return [corner[0] + reach * Math.cos(angle), corner[1] + reach * Math.sin(angle)]
    })
  })
}
