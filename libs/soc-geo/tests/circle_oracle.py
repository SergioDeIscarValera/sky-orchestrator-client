"""Writes contracts/geometry/circle.json, the circle tool's golden vectors (FR-WAY-04).

    uv run python libs/soc-geo/tests/circle_oracle.py > contracts/geometry/circle.json

A circle is drawn on the local frame: its points at the radius from its centre, the
first at its start bearing, the rest round it in its direction, as many as keep each
arc within the spacing (three at least), the last back at the first. The points come
from the closed form in `soc_geo.projection`, the same the console's TypeScript
writes; pyproj's geodesic, the oracle, checks the requirement on every one: at the
radius within 0.1 m, no arc longer than the spacing.
"""

from __future__ import annotations

import itertools
import json
import math
import sys
from typing import Any

import pyproj

from soc_geo.projection import EastNorth, Geodetic, east_north, geodetic_at

ORIGIN = Geodetic(41.6523, -4.7245)
CIRCLES = [
    ("small clockwise", (41.6519, -4.7240), 30.0, True, 0.0, 10.0),
    ("small counter-clockwise from east", (41.6519, -4.7240), 30.0, False, 90.0, 10.0),
    ("tighter than three points", (41.6525, -4.7250), 1.0, True, 45.0, 10.0),
    ("wide, fine spacing", (41.6540, -4.7200), 250.0, True, 333.0, 7.5),
    ("a kilometre away, coarse", (41.6610, -4.7300), 120.0, False, 180.0, 50.0),
]


def points(
    centre: Geodetic, radius_m: float, clockwise: bool, start_deg: float, spacing_m: float
) -> list[Geodetic]:
    middle = east_north(ORIGIN, centre)
    count = max(3, math.ceil(2 * math.pi * radius_m / spacing_m))
    turn = 1 if clockwise else -1
    found = []
    for step in range(count + 1):
        bearing = math.radians(start_deg + turn * 360.0 * (step % count) / count)
        place = EastNorth(
            middle.east_m + radius_m * math.sin(bearing),
            middle.north_m + radius_m * math.cos(bearing),
        )
        found.append(geodetic_at(ORIGIN, place))
    return found


def vectors() -> dict[str, Any]:
    geodesic = pyproj.Geod(ellps="WGS84")
    cases = []
    for name, (latitude, longitude), radius_m, clockwise, start_deg, spacing_m in CIRCLES:
        centre = Geodetic(latitude, longitude)
        found = points(centre, radius_m, clockwise, start_deg, spacing_m)
        for point in found:
            _, _, distance = geodesic.inv(
                longitude, latitude, point.longitude_deg, point.latitude_deg
            )
            assert abs(distance - radius_m) < 0.1, (name, distance)
        for a, b in itertools.pairwise(found):
            chord = geodesic.inv(a.longitude_deg, a.latitude_deg, b.longitude_deg, b.latitude_deg)[
                2
            ]
            arc = 2 * radius_m * math.asin(min(1.0, chord / (2 * radius_m)))
            assert arc <= spacing_m + 1e-6, (name, arc)
        cases.append(
            {
                "name": name,
                "centre": {"latitude_deg": latitude, "longitude_deg": longitude},
                "radius_m": radius_m,
                "clockwise": clockwise,
                "start_bearing_deg": start_deg,
                "max_arc_spacing_m": spacing_m,
                "points": [
                    # Unrounded: a ten-decimal degree is already 11 µm.
                    {"latitude_deg": p.latitude_deg, "longitude_deg": p.longitude_deg}
                    for p in found
                ],
            }
        )
    return {
        "description": (
            "The circle tool's points (FR-WAY-04), every implementation within tolerance_m "
            "on the local frame at origin: at the radius from the centre, the first at the "
            "start bearing, the rest in the circle's direction, three at least and as many as "
            "keep each arc within max_arc_spacing_m, the last back at the first. Written by "
            "libs/soc-geo/tests/circle_oracle.py; pyproj's geodesic checks every point."
        ),
        "x-version": "1.0.0",
        "tolerance_m": 1e-6,
        "origin": {"latitude_deg": ORIGIN.latitude_deg, "longitude_deg": ORIGIN.longitude_deg},
        "cases": cases,
    }


if __name__ == "__main__":
    json.dump(vectors(), sys.stdout, indent=2)
    sys.stdout.write("\n")
