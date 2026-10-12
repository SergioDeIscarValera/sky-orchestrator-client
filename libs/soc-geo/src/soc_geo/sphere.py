"""Distances as Sky Orchestrator measures its limits (ADR-0009).

Sky Orchestrator checks every limit of a flight, on its server and on the phone,
with a haversine on a sphere of the IUGG mean radius. A limit checked in any other
metric disagrees with it right at the limit, so SOC's validators measure SO's
limits here, and only SO's limits: everything else goes through the local frame
(`soc_geo.projection`). The vendored geodesy cases hold this to SO's own values,
contracts/sky-orchestrator/msdk/geodesy-cases.json.
"""

from __future__ import annotations

import math

from soc_geo.projection import Geodetic

#: IUGG mean Earth radius, as Sky Orchestrator's so_wayline/geodesy.py and Geodesy.kt.
EARTH_RADIUS_M = 6_371_008.8


def checked(point: Geodetic) -> Geodetic:
    """`point`, refused when it cannot be a position.

    A NaN makes every distance NaN, and NaN compares false against every limit, so
    it would pass every check: it fails here instead, as it does in SO.
    """
    if not (math.isfinite(point.latitude_deg) and -90.0 <= point.latitude_deg <= 90.0):
        raise ValueError(f"latitude out of range: {point.latitude_deg}")
    if not (math.isfinite(point.longitude_deg) and -180.0 <= point.longitude_deg <= 180.0):
        raise ValueError(f"longitude out of range: {point.longitude_deg}")
    return point


def _longitude_step_deg(a: Geodetic, b: Geodetic) -> float:
    step = b.longitude_deg - a.longitude_deg
    while step > 180.0:
        step -= 360.0
    while step <= -180.0:
        step += 360.0
    return step


def distance_m(a: Geodetic, b: Geodetic) -> float:
    """The great-circle distance by the haversine, stable at short range, as SO's."""
    checked(a)
    checked(b)
    lat1 = math.radians(a.latitude_deg)
    lat2 = math.radians(b.latitude_deg)
    d_lat = lat2 - lat1
    d_lon = math.radians(_longitude_step_deg(a, b))
    h = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))
