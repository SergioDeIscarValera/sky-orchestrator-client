"""Plane geometry on the local frame: what SOC's validators decide with (ADR-0009).

Points are (east, north) in metres on the organization's tangent plane
(`soc_geo.projection`). Every decision, on which side of a line a point lies,
whether two edges meet, whether a point is inside, rests on one orientation test
that is exact: a float is a rational number, so the determinant can be computed
without rounding, and no rounding can flip a decision at a boundary. A float
filter answers first, and the exact sum only where the filter cannot be sure.
Distances are measured in floats: they are compared with margins of metres.

The golden vectors of contracts/geometry/planar.json hold this, and the console's
TypeScript, to shapely within their tolerance.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

type Point = tuple[float, float]
type Polygon = Sequence[Point]
type Place = Literal["inside", "boundary", "outside"]

#: Shewchuk's error bound for the orientation determinant in doubles: past it, the
#: sign of the float determinant is the sign of the exact one.
_FILTER = (3.0 + 16.0 * 2.0**-53) * 2.0**-53


def orientation(a: Point, b: Point, c: Point) -> int:
    """The turn a → b → c, exactly: 1 counter-clockwise, -1 clockwise, 0 straight."""
    left = (b[0] - a[0]) * (c[1] - a[1])
    right = (b[1] - a[1]) * (c[0] - a[0])
    determinant = left - right
    if abs(determinant) > _FILTER * (abs(left) + abs(right)):
        return (determinant > 0) - (determinant < 0)
    ax, ay, bx, by, cx, cy = (Fraction(value) for value in (*a, *b, *c))
    exact = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    return (exact > 0) - (exact < 0)


def _within_box(p: Point, a: Point, b: Point) -> bool:
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def on_segment(p: Point, a: Point, b: Point) -> bool:
    """Whether `p` lies on the closed segment a-b."""
    return orientation(a, b, p) == 0 and _within_box(p, a, b)


def segments_meet(a: Point, b: Point, c: Point, d: Point) -> bool:
    """Whether the closed segments a-b and c-d share a point, touching included."""
    o1, o2 = orientation(a, b, c), orientation(a, b, d)
    o3, o4 = orientation(c, d, a), orientation(c, d, b)
    if o1 != o2 and o3 != o4 and 0 not in (o1, o2, o3, o4):
        return True
    return (
        (o1 == 0 and _within_box(c, a, b))
        or (o2 == 0 and _within_box(d, a, b))
        or (o3 == 0 and _within_box(a, c, d))
        or (o4 == 0 and _within_box(b, c, d))
    )


def edges(polygon: Polygon) -> list[tuple[Point, Point]]:
    """The polygon's edges, the last closing it back to the first vertex."""
    return [(polygon[i], polygon[(i + 1) % len(polygon)]) for i in range(len(polygon))]


def signed_area(polygon: Polygon) -> float:
    """The shoelace area: positive counter-clockwise, negative clockwise."""
    return 0.5 * math.fsum(a[0] * b[1] - b[0] * a[1] for a, b in edges(polygon))


def perimeter(polygon: Polygon) -> float:
    return math.fsum(math.dist(a, b) for a, b in edges(polygon))


@dataclass(frozen=True)
class Problem:
    """Why a polygon is not simple, with the edges it is about (FR-GEO-01, FR-GEO-04)."""

    rule: Literal["too_few_vertices", "zero_length_edge", "edges_meet", "no_area"]
    edges: tuple[int, ...] = ()


def problems(polygon: Polygon) -> list[Problem]:
    """Everything that keeps `polygon` from being simple, each with its edges, or none."""
    count = len(polygon)
    if count < 3:
        return [Problem("too_few_vertices")]
    found = [Problem("zero_length_edge", (i,)) for i, (a, b) in enumerate(edges(polygon)) if a == b]
    sides = edges(polygon)
    for i in range(count):
        for j in range(i + 1, count):
            (a, b), (c, d) = sides[i], sides[j]
            if j == i + 1 or (i == 0 and j == count - 1):
                # Neighbours share a vertex; they fail only by doubling back along each other.
                shared, mine, theirs = (b, a, d) if j == i + 1 else (a, b, c)
                if (
                    a != b
                    and c != d
                    and orientation(shared, mine, theirs) == 0
                    and (_within_box(theirs, shared, mine) or _within_box(mine, shared, theirs))
                ):
                    found.append(Problem("edges_meet", (i, j)))
                continue
            if segments_meet(a, b, c, d):
                found.append(Problem("edges_meet", (i, j)))
    if not found and all(orientation(polygon[0], polygon[1], point) == 0 for point in polygon[2:]):
        found.append(Problem("no_area"))
    return found


def locate(polygon: Polygon, p: Point) -> Place:
    """Where `p` lies against a simple polygon, decided exactly, its boundary included."""
    winding = 0
    for a, b in edges(polygon):
        if on_segment(p, a, b):
            return "boundary"
        if a[1] <= p[1] < b[1] and orientation(a, b, p) > 0:
            winding += 1
        elif b[1] <= p[1] < a[1] and orientation(a, b, p) < 0:
            winding -= 1
    return "inside" if winding != 0 else "outside"


def distance_to_segment(p: Point, a: Point, b: Point) -> float:
    """The distance from `p` to the closed segment a-b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    if length == 0:
        return math.dist(p, a)
    share = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return math.dist(p, (a[0] + share * dx, a[1] + share * dy))


def segment_distance(a: Point, b: Point, c: Point, d: Point) -> float:
    """The distance between the closed segments a-b and c-d: zero when they meet."""
    if segments_meet(a, b, c, d):
        return 0.0
    return min(
        distance_to_segment(a, c, d),
        distance_to_segment(b, c, d),
        distance_to_segment(c, a, b),
        distance_to_segment(d, a, b),
    )


def leg_clearance(polygon: Polygon, a: Point, b: Point) -> float | None:
    """How far the leg a-b keeps from the polygon's boundary, all of it inside, or None
    when any of it is on the boundary or outside.

    Both ends inside is not enough: a leg between the two arms of a U leaves the
    polygon with both its ends in it (ADR-0009). So every edge is tried against
    the leg itself.
    """
    if locate(polygon, a) != "inside" or locate(polygon, b) != "inside":
        return None
    if any(segments_meet(a, b, c, d) for c, d in edges(polygon)):
        return None
    return min(segment_distance(a, b, c, d) for c, d in edges(polygon))
