"""The cloud geofence's judgement of one telemetry sample (FR-SAF-01, ADR-0010).

soc-cloud checks every aircraft sample of an executing flight against that flight's
geofence snapshot as it arrives, and soc-operations checks the same judgement when it
validates a flight. It is held here once, as pure functions: they read their inputs and
say where the sample stands. What a breach sets off (return_home, the event) is the
caller's, never this module's.

The geofence is its ring as stored, [longitude, latitude] positions in GeoJSON order and
not closed (IR-GEO, the units table), and its ceiling, metres above the takeoff point.
`geofence_of` takes the snapshot once: it checks that the ring is a simple polygon and
places it on the organization's local frame (`soc_geo.projection`, ADR-0014). The check
costs quadratically in the vertices, so it is paid once per flight, not per sample.
`judge` then places each sample on the same frame. Every distance is in metres on that
tangent plane, to the nearest edge by `soc_geo.planar.distance_to_segment`, the measure
the leg clearances of the validators use. A height is compared with the ceiling as it
is, never placed in the frame.

The conventions, each held by a test in `tests/test_fence.py`:

- The boundary belongs to the polygon: a point exactly on an edge is not outside, as a
  value exactly at a limit passes in Sky Orchestrator (`soc_geo.limits`). It is 0 m from
  the boundary, so its verdict is a warning, not inside.
- The ceiling is passed at its own height: above means strictly higher.
- The warning band is horizontal, the strip inside the boundary (the glossary's warning
  band, the config's distance inside the geofence boundary). A sample inside the polygon
  at most `warning_band_m` from an edge, the band's edge included, is a warning. The
  ceiling has no band: a height under it is inside, however near it is.
- A breach that the position proves stays outside when the height is missing, and one
  that the height proves stays outside when the position is missing: a missing input
  cannot undo a breach. Otherwise a position or height that is missing or not finite is
  unknown, never inside (FR-SAF-03).
- A geofence that cannot be judged against is refused with ValueError, never judged: a
  ring that is not a simple polygon, a ceiling not above zero, an origin or a ring
  position that is not a position. A warning band that is negative or not finite is
  refused the same way, when a sample is judged.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from soc_geo.planar import Point, distance_to_segment, edges, locate, problems
from soc_geo.projection import Geodetic, east_north
from soc_geo.sphere import checked


class Verdict(StrEnum):
    INSIDE = "inside"
    WARNING = "warning"
    OUTSIDE = "outside"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Geofence:
    """A geofence snapshot as the check holds it: its ring on the local frame.

    Build it with `geofence_of`, which runs the check; constructing one by hand skips it.
    """

    origin: Geodetic
    polygon: tuple[Point, ...]
    ceiling_m: float


@dataclass(frozen=True)
class Judgement:
    """Where one sample stands against one geofence.

    `distance_outside_m` is set exactly when the verdict is outside: the horizontal
    distance to the polygon when the sample is off it, else the height above the ceiling.
    `distance_to_boundary_m` is set exactly when the verdict is inside or warning.
    `above_ceiling_m` is set whenever the sample's height is above the ceiling.
    """

    verdict: Verdict
    distance_outside_m: float | None
    distance_to_boundary_m: float | None
    above_ceiling_m: float | None
    reason: str


def geofence_of(origin: Geodetic, ring: Sequence[Sequence[float]], max_height_m: float) -> Geofence:
    """The geofence snapshot the check judges against, refused unless it can be judged.

    `origin` is the organization's position, the origin of the one local frame. `ring` is
    the geofence's ring as stored, and `max_height_m` its ceiling above the takeoff point.
    """
    checked(origin)
    polygon: list[Point] = []
    for longitude, latitude in ring:
        polygon.append(_on_plane(origin, checked(Geodetic(latitude, longitude))))
    found = problems(polygon)
    if found:
        named = "; ".join(
            f"{problem.rule} on edges {list(problem.edges)}" if problem.edges else problem.rule
            for problem in found
        )
        raise ValueError(f"the geofence is not a simple polygon: {named}")
    return Geofence(origin=origin, polygon=tuple(polygon), ceiling_m=_ceiling(max_height_m))


def judge(
    fence: Geofence,
    position: Geodetic | None,
    height_m: float | None,
    warning_band_m: float,
) -> Judgement:
    """Where a sample stands against a geofence, by the conventions of this module.

    `position` is the sample's latitude and longitude, None when it has none, and
    `height_m` its height above the takeoff point, None when it has none. `warning_band_m`
    is the band in metres.
    """
    band = _band(warning_band_m)
    missing: list[str] = []
    off_polygon: bool | None = None
    edge_m = 0.0
    if position is None:
        missing.append("the position is missing")
    elif not _is_position(position):
        missing.append("the position is not finite or out of range")
    else:
        point = _on_plane(fence.origin, position)
        where = locate(fence.polygon, point)
        off_polygon = where == "outside"
        nearest = min(distance_to_segment(point, a, b) for a, b in edges(fence.polygon))
        edge_m = 0.0 if where == "boundary" else nearest
    above: bool | None = None
    over_m: float | None = None
    if height_m is None:
        missing.append("the height is missing")
    elif not math.isfinite(height_m):
        missing.append("the height is not finite")
    else:
        above = height_m > fence.ceiling_m
        over_m = height_m - fence.ceiling_m if above else None
    if off_polygon is True or above is True:
        verdict = Verdict.OUTSIDE
    elif off_polygon is None or above is None:
        verdict = Verdict.UNKNOWN
    elif edge_m <= band:
        verdict = Verdict.WARNING
    else:
        verdict = Verdict.INSIDE
    outside_m = (edge_m if off_polygon else over_m) if verdict is Verdict.OUTSIDE else None
    boundary_m = edge_m if verdict in (Verdict.INSIDE, Verdict.WARNING) else None
    return Judgement(
        verdict=verdict,
        distance_outside_m=outside_m,
        distance_to_boundary_m=boundary_m,
        above_ceiling_m=over_m,
        reason=_reason(verdict, edge_m, band, off_polygon, over_m, missing),
    )


def _m(value: float) -> str:
    return f"{value:.1f} m"


def _on_plane(origin: Geodetic, position: Geodetic) -> Point:
    placed = east_north(origin, position)
    return (placed.east_m, placed.north_m)


def _is_position(position: Geodetic) -> bool:
    try:
        checked(position)
    except ValueError:
        return False
    return True


def _ceiling(max_height_m: float) -> float:
    if not (math.isfinite(max_height_m) and max_height_m > 0):
        raise ValueError(f"the geofence's ceiling must be finite and above zero: {max_height_m}")
    return max_height_m


def _band(warning_band_m: float) -> float:
    if not (math.isfinite(warning_band_m) and warning_band_m >= 0):
        raise ValueError(f"the warning band must be finite and zero or more: {warning_band_m}")
    return warning_band_m


def _reason(
    verdict: Verdict,
    edge_m: float,
    band: float,
    off_polygon: bool | None,
    over_m: float | None,
    missing: list[str],
) -> str:
    if verdict is Verdict.UNKNOWN:
        return "unknown: " + "; ".join(missing)
    if verdict is Verdict.OUTSIDE:
        parts: list[str] = []
        if off_polygon:
            parts.append(f"outside the polygon by {_m(edge_m)}")
        if over_m is not None:
            parts.append(f"above the ceiling by {_m(over_m)}")
        text = " and ".join(parts)
    elif verdict is Verdict.WARNING:
        text = f"inside, {_m(edge_m)} from the boundary, within the {_m(band)} band"
    else:
        text = f"inside, {_m(edge_m)} from the boundary"
    return "; ".join([text, *missing])
