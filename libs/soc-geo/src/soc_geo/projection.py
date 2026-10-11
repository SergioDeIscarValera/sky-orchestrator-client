"""The one local frame (ADR-0009, ADR-0014): the east-north tangent plane at the
organization's position on the WGS84 ellipsoid, written in closed form.

A point is placed through Earth-centred coordinates, both at the ellipsoid's
surface, then turned into east and north at the origin. Heights never go through
this frame: a height above takeoff stays one (ADR-0014). The golden vectors of
contracts/geometry/projection.json hold this and the console's TypeScript to PROJ
within their tolerance.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SEMI_MAJOR_AXIS_M = 6_378_137.0
FLATTENING = 1 / 298.257223563
ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING)


@dataclass(frozen=True)
class Geodetic:
    latitude_deg: float
    longitude_deg: float


@dataclass(frozen=True)
class EastNorth:
    east_m: float
    north_m: float


def _earth_centred(point: Geodetic) -> tuple[float, float, float]:
    latitude = math.radians(point.latitude_deg)
    longitude = math.radians(point.longitude_deg)
    sine = math.sin(latitude)
    prime_vertical = SEMI_MAJOR_AXIS_M / math.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
    return (
        prime_vertical * math.cos(latitude) * math.cos(longitude),
        prime_vertical * math.cos(latitude) * math.sin(longitude),
        prime_vertical * (1 - ECCENTRICITY_SQUARED) * sine,
    )


def east_north(origin: Geodetic, point: Geodetic) -> EastNorth:
    """Where `point` lies on the tangent plane at `origin`, in metres."""
    ox, oy, oz = _earth_centred(origin)
    px, py, pz = _earth_centred(point)
    dx, dy, dz = px - ox, py - oy, pz - oz
    latitude = math.radians(origin.latitude_deg)
    longitude = math.radians(origin.longitude_deg)
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    sin_lon, cos_lon = math.sin(longitude), math.cos(longitude)
    return EastNorth(
        east_m=-sin_lon * dx + cos_lon * dy,
        north_m=-sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz,
    )
