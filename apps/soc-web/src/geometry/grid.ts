import { convexHull } from './margin'
import { edges, type Point, type Polygon } from './planar'

/**
 * The grid tool (FR-WAY-05) on the local frame, [east, north] in metres: an area
 * covered by parallel lines `lineSpacingM` apart, flown back and forth, at the angle
 * that needs the fewest lines unless one is given. The lines are centred on the area's
 * width, the outer ones at most half a spacing in from its edges, so the strips half a
 * spacing either side of the lines cover it; each point keeps half a point spacing from
 * the ends of the stretch of line inside the area, so every point lies inside it.
 */
export interface Grid {
  readonly area: Polygon
  readonly lineSpacingM: number
  readonly pointSpacingM: number
  /** The lines' bearing, clockwise from true north, in [0, 180); absent, the fewest lines. */
  readonly angleDeg?: number
}

export interface Coverage {
  /** The lines' bearing the grid was flown at. */
  readonly angleDeg: number
  /** Each line's points in the order flown, the lines in the order flown. */
  readonly lines: readonly (readonly Point[])[]
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Along and across a bearing: `along` points the way the lines run, `across` to their right. */
function axes(angleDeg: number) {
  const angle = radians(angleDeg)
  const along: Point = [Math.sin(angle), Math.cos(angle)]
  const across: Point = [Math.cos(angle), -Math.sin(angle)]
  return { along, across }
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]

/** How wide `area` is across lines at `angleDeg`: the span of its vertices on the across axis. */
function widthAcross(area: Polygon, angleDeg: number): readonly [number, number] {
  const { across } = axes(angleDeg)
  const offsets = area.map((point) => dot(point, across))
  return [Math.min(...offsets), Math.max(...offsets)]
}

/** How many lines `lineSpacingM` apart cover a width: one at least. */
export function linesFor(widthM: number, lineSpacingM: number): number {
  return Math.max(1, Math.ceil(widthM / lineSpacingM - 1e-9))
}

/**
 * The bearing that needs the fewest lines: the area is narrowest across one of its
 * hull's edges, so lines along each edge are tried, and of those that need the fewest,
 * the narrowest, then the smallest bearing, wins.
 */
export function fewestLinesAngle(area: Polygon, lineSpacingM: number): number {
  const hull = convexHull(area)
  const candidates = edges(hull).map(([a, b]) => {
    const bearing = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI
    return ((bearing % 180) + 180) % 180
  })
  let best: { angle: number; lines: number; width: number } | null = null
  for (const angle of candidates.sort((x, y) => x - y)) {
    const [low, high] = widthAcross(area, angle)
    const width = high - low
    const lines = linesFor(width, lineSpacingM)
    if (
      best === null ||
      lines < best.lines ||
      (lines === best.lines && width < best.width - 1e-9)
    ) {
      best = { angle, lines, width }
    }
  }
  return best?.angle ?? 0
}

/** Where the line `offset` across meets the area's edges, as distances along it, in pairs. */
function stretches(area: Polygon, angleDeg: number, offset: number): (readonly [number, number])[] {
  const { along, across } = axes(angleDeg)
  const crossings: number[] = []
  for (const [a, b] of edges(area)) {
    const da = dot(a, across) - offset
    const db = dot(b, across) - offset
    // Half-open, so a vertex on the line is counted once.
    if ((da < 0 && db >= 0) || (db < 0 && da >= 0)) {
      const share = da / (da - db)
      const point: Point = [a[0] + share * (b[0] - a[0]), a[1] + share * (b[1] - a[1])]
      crossings.push(dot(point, along))
    }
  }
  crossings.sort((x, y) => x - y)
  const found: (readonly [number, number])[] = []
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const start = crossings[index]
    const end = crossings[index + 1]
    if (start !== undefined && end !== undefined && end > start) found.push([start, end])
  }
  return found
}

/** Points along [start, end]: half a spacing in from each end, at most a spacing apart. */
function pointsAlong(start: number, end: number, spacing: number): number[] {
  const length = end - start
  if (length <= spacing) return [(start + end) / 2]
  const first = start + spacing / 2
  const last = end - spacing / 2
  const steps = Math.max(1, Math.ceil((last - first) / spacing - 1e-9))
  return Array.from({ length: steps + 1 }, (_, step) => first + ((last - first) * step) / steps)
}

/** The grid's coverage of its area: its lines, each back the other way from the last. */
export function cover(grid: Grid): Coverage {
  const angleDeg = grid.angleDeg ?? fewestLinesAngle(grid.area, grid.lineSpacingM)
  const { along, across } = axes(angleDeg)
  const [low, high] = widthAcross(grid.area, angleDeg)
  const count = linesFor(high - low, grid.lineSpacingM)
  // Centred on the area's width, so its spare is shared out at both sides.
  const firstOffset = (low + high) / 2 - ((count - 1) * grid.lineSpacingM) / 2
  const lines: Point[][] = []
  for (let line = 0; line < count; line += 1) {
    const offset = firstOffset + line * grid.lineSpacingM
    const distances = stretches(grid.area, angleDeg, offset).flatMap(([start, end]) =>
      pointsAlong(start, end, grid.pointSpacingM),
    )
    if (distances.length === 0) continue
    const ordered = lines.length % 2 === 0 ? distances : [...distances].reverse()
    lines.push(
      ordered.map((distance): Point => [
        offset * across[0] + distance * along[0],
        offset * across[1] + distance * along[1],
      ]),
    )
  }
  return { angleDeg, lines }
}
