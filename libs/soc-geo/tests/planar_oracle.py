"""Writes contracts/geometry/planar.json from shapely, the test oracle (ADR-0009).

    uv run python libs/soc-geo/tests/planar_oracle.py > contracts/geometry/planar.json

Polygons a geofence could be, and some it must never be: a square, a triangle, a U
whose arms a leg can jump while both its ends stay inside, a farm-sized polygon of
32 vertices; and a bow-tie, a spike that doubles back, collinear vertices, a vertex
repeated, too few. For each: its area, perimeter and whether shapely holds it
simple; points located inside, on or outside it; legs with their clearance from
its boundary, or none when they leave it. A point or leg near a decision is kept at
least 1 mm from it, so tolerance never decides a vector. shapely never runs in a
service.
"""

from __future__ import annotations

import json
import math
import random
import sys
from typing import Any

from shapely.geometry import LinearRing, LineString, Point, Polygon

TOLERANCE_M = 1e-6
#: How far from a decision a generated point or leg keeps (ADR-0009).
MARGIN_M = 1e-3
type Coordinates = list[tuple[float, float]]


def farm(seed: int = 7) -> Coordinates:
    """32 vertices round a centre at radii from 300 to 700 m: star-shaped, so simple."""
    rng = random.Random(seed)  # noqa: S311 - a seeded polygon, not a secret
    radii = [rng.uniform(300.0, 700.0) for _ in range(32)]
    return [
        (
            round(radius * math.cos(2 * math.pi * i / 32), 3),
            round(radius * math.sin(2 * math.pi * i / 32), 3),
        )
        for i, radius in enumerate(radii)
    ]


SIMPLE: dict[str, Coordinates] = {
    "square": [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)],
    "triangle clockwise": [(0.0, 0.0), (-40.0, 80.0), (60.0, 30.0)],
    "u": [
        (0.0, 0.0),
        (100.0, 0.0),
        (100.0, 100.0),
        (70.0, 100.0),
        (70.0, 30.0),
        (30.0, 30.0),
        (30.0, 100.0),
        (0.0, 100.0),
    ],
    "farm": farm(),
}

NOT_SIMPLE: dict[str, Coordinates] = {
    "bow-tie": [(0.0, 0.0), (100.0, 100.0), (100.0, 0.0), (0.0, 100.0)],
    "spike doubling back": [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (100.0, 50.0), (0.0, 100.0)],
    "collinear": [(0.0, 0.0), (50.0, 50.0), (100.0, 100.0)],
    "vertex repeated": [(0.0, 0.0), (100.0, 0.0), (100.0, 0.0), (100.0, 100.0)],
    "two vertices": [(0.0, 0.0), (100.0, 0.0)],
}


def crossing_edges(coordinates: Coordinates) -> list[list[int]]:
    """Pairs of edges that meet where they should not: non-neighbours that touch, and
    neighbours that overlap beyond their shared vertex."""
    count = len(coordinates)
    sides = [LineString([coordinates[i], coordinates[(i + 1) % count]]) for i in range(count)]
    found: list[list[int]] = []
    for i in range(count):
        for j in range(i + 1, count):
            if sides[i].length == 0 or sides[j].length == 0:
                continue
            shared = sides[i].intersection(sides[j])
            neighbours = j == i + 1 or (i == 0 and j == count - 1)
            if neighbours and (shared.geom_type == "Point" or shared.is_empty):
                continue
            if not shared.is_empty:
                found.append([i, j])
    return found


def polygon_case(name: str, coordinates: Coordinates) -> dict[str, Any]:
    count = len(coordinates)
    case: dict[str, Any] = {"name": name, "polygon": [list(point) for point in coordinates]}
    if count < 3:
        return {**case, "simple": False, "rules": ["too_few_vertices"]}
    rules = [
        "zero_length_edge" for i in range(count) if coordinates[i] == coordinates[(i + 1) % count]
    ]
    rules += ["edges_meet"] * len(crossing_edges(coordinates))
    shape = Polygon(coordinates)
    if not rules and shape.area == 0:
        rules.append("no_area")
    # A vertex repeated is not simple for SOC, whatever GEOS tolerates: an edge of no length.
    simple = (
        LinearRing(coordinates).is_simple
        and shape.is_valid
        and shape.area > 0
        and "zero_length_edge" not in rules
    )
    assert simple == (not rules), name
    case.update(
        simple=simple,
        rules=sorted(set(rules)),
        crossing_edges=crossing_edges(coordinates),
        area_m2=round(abs(shape.area), 9) if simple else None,
        perimeter_m=round(LinearRing(coordinates).length, 9),
        counter_clockwise=LinearRing(coordinates).is_ccw if simple else None,
    )
    return case


def place(shape: Polygon, xy: tuple[float, float]) -> str | None:
    point = Point(xy)
    if shape.exterior.distance(point) == 0:
        return "boundary"
    if shape.exterior.distance(point) < MARGIN_M:
        return None
    return "inside" if shape.contains(point) else "outside"


def clearance(shape: Polygon, a: tuple[float, float], b: tuple[float, float]) -> tuple[bool, float]:
    leg = LineString([a, b])
    inside = shape.contains(leg) and not leg.intersects(shape.exterior)
    return inside, shape.exterior.distance(leg)


def located(name: str, coordinates: Coordinates, rng: random.Random) -> list[dict[str, Any]]:
    shape = Polygon(coordinates)
    minx, miny, maxx, maxy = shape.bounds
    points: list[tuple[float, float]] = [coordinates[0], coordinates[1]]
    # The midpoint of an edge parallel to an axis is exact: on the boundary to the bit.
    for (ax, ay), (bx, by) in zip(coordinates, coordinates[1:] + coordinates[:1], strict=True):
        if ax == bx or ay == by:
            points.append(((ax + bx) / 2, (ay + by) / 2))
            break
    while len(points) < 24:
        candidate = (
            round(rng.uniform(minx - 20, maxx + 20), 3),
            round(rng.uniform(miny - 20, maxy + 20), 3),
        )
        if place(shape, candidate) is not None:
            points.append(candidate)
    return [
        {"polygon": name, "point": list(point), "place": place(shape, point)} for point in points
    ]


def legs(name: str, coordinates: Coordinates, rng: random.Random) -> list[dict[str, Any]]:
    shape = Polygon(coordinates)
    minx, miny, maxx, maxy = shape.bounds
    found: list[dict[str, Any]] = []
    while len(found) < 16:
        a = (round(rng.uniform(minx, maxx), 3), round(rng.uniform(miny, maxy), 3))
        b = (round(rng.uniform(minx, maxx), 3), round(rng.uniform(miny, maxy), 3))
        inside, distance = clearance(shape, a, b)
        # Inside, it keeps clear of the boundary; out of it, it leaves by a clear length.
        leaves_clearly = LineString([a, b]).difference(shape).length >= MARGIN_M
        if (inside and distance < MARGIN_M) or (not inside and not leaves_clearly):
            continue
        found.append(
            {
                "polygon": name,
                "from": list(a),
                "to": list(b),
                "clearance_m": round(distance, 9) if inside else None,
            }
        )
    return found


def vectors() -> dict[str, Any]:
    rng = random.Random(2026)  # noqa: S311 - seeded vectors, not a secret
    u_jump = {"polygon": "u", "from": [15.0, 90.0], "to": [85.0, 90.0], "clearance_m": None}
    u_inside: dict[str, Any] = {"polygon": "u", "from": [15.0, 20.0], "to": [85.0, 15.0]}
    inside, distance = clearance(Polygon(SIMPLE["u"]), (15.0, 20.0), (85.0, 15.0))
    u_inside["clearance_m"] = round(distance, 9) if inside else None
    return {
        "description": (
            "Plane geometry on the local frame that every implementation of SOC's "
            "validators and generators reproduces within tolerance_m (ADR-0009): "
            "polygons with their simplicity, area and perimeter; points located inside, "
            "on or outside them; legs with their clearance from the boundary, null when "
            "any of a leg is on or outside it. Written by libs/soc-geo/tests/planar_oracle.py "
            "from shapely."
        ),
        "x-version": "1.0.0",
        "tolerance_m": TOLERANCE_M,
        "polygons": [polygon_case(name, c) for name, c in {**SIMPLE, **NOT_SIMPLE}.items()],
        "points": [p for name, c in SIMPLE.items() for p in located(name, c, rng)],
        "legs": [u_jump, u_inside]
        + [leg for name, c in SIMPLE.items() for leg in legs(name, c, rng)],
    }


if __name__ == "__main__":
    json.dump(vectors(), sys.stdout, indent=2)
    sys.stdout.write("\n")
