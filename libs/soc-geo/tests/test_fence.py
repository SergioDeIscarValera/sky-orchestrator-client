"""The cloud geofence's judgement of a sample, one fixture per rule (FR-SAF-01, ADR-0010).

The geofences are drawn on the farm's local frame, metres east and north of the origin,
and stored the way the console stores a ring: [longitude, latitude] positions in GeoJSON
order, not closed. Samples are placed the same way, and every distance is in metres.
"""

from __future__ import annotations

import dataclasses
import math
import random
from collections.abc import Sequence

import pytest
from shapely.geometry import Point as ShapelyPoint
from shapely.geometry import Polygon

from soc_geo.fence import Judgement, Verdict, geofence_of, judge
from soc_geo.planar import Point
from soc_geo.projection import EastNorth, Geodetic, east_north, geodetic_at

FARM = Geodetic(41.6523, -4.7245)
CEILING_M = 120.0
BAND_M = 5.0
#: Distances agree to a centimetre, far above the frame's own error.
CM = 0.01


def at(east: float, north: float) -> Geodetic:
    """The sample `east` and `north` metres from the farm."""
    return geodetic_at(FARM, EastNorth(east, north))


def stored(*points: tuple[float, float]) -> list[list[float]]:
    """A ring of (east, north) metres, stored the way the console stores it."""
    ring: list[list[float]] = []
    for east, north in points:
        placed = at(east, north)
        ring.append([placed.longitude_deg, placed.latitude_deg])
    return ring


def on_plane(ring: Sequence[Sequence[float]]) -> list[Point]:
    """The stored ring on the farm's plane, as the judgement places it."""
    placed = [east_north(FARM, Geodetic(latitude, longitude)) for longitude, latitude in ring]
    return [(p.east_m, p.north_m) for p in placed]


#: A 100 m square centred on the farm.
SQUARE = stored((-50.0, -50.0), (50.0, -50.0), (50.0, 50.0), (-50.0, 50.0))
#: A U open to the north: its notch, between the arms, is outside though inside the hull.
U = stored(
    (0.0, 0.0),
    (100.0, 0.0),
    (100.0, 100.0),
    (70.0, 100.0),
    (70.0, 30.0),
    (30.0, 30.0),
    (30.0, 100.0),
    (0.0, 100.0),
)


def star(vertices: int, seed: int = 7) -> list[list[float]]:
    """A star-shaped ring round the farm, radii 20 to 60 m: simple, with many edges."""
    rng = random.Random(seed)  # noqa: S311 - a seeded shape, not a secret
    points: list[tuple[float, float]] = []
    for i in range(vertices):
        radius = rng.uniform(20.0, 60.0)
        angle = 2 * math.pi * i / vertices
        points.append((radius * math.cos(angle), radius * math.sin(angle)))
    return stored(*points)


def judged(
    ring: Sequence[Sequence[float]],
    position: Geodetic | None,
    height_m: float | None,
    *,
    ceiling_m: float = CEILING_M,
    band_m: float = BAND_M,
) -> Judgement:
    return judge(geofence_of(FARM, ring, ceiling_m), position, height_m, band_m)


def same(actual: float | None, expected: float | None) -> bool:
    if actual is None or expected is None:
        return actual is expected
    return math.isclose(actual, expected, abs_tol=1e-9)


def test_inside_far_from_every_edge_is_inside() -> None:
    found = judged(SQUARE, at(0.0, 0.0), 30.0)
    assert found.verdict is Verdict.INSIDE
    assert found.distance_to_boundary_m == pytest.approx(50.0, abs=CM)
    assert found.distance_outside_m is None
    assert found.above_ceiling_m is None


def test_inside_within_the_band_of_an_edge_is_a_warning() -> None:
    found = judged(SQUARE, at(48.0, 0.0), 30.0)
    assert found.verdict is Verdict.WARNING
    assert found.distance_to_boundary_m == pytest.approx(2.0, abs=CM)
    assert found.distance_outside_m is None


def test_inside_within_the_band_of_a_reflex_vertex_is_measured_to_the_vertex() -> None:
    # One metre from each arm's line, but both feet fall beyond the segments: the nearest
    # boundary point is the vertex (70, 30), sqrt(2) m away. A line distance would say 1 m.
    found = judged(U, at(71.0, 29.0), 30.0)
    assert found.verdict is Verdict.WARNING
    assert found.distance_to_boundary_m == pytest.approx(math.sqrt(2.0), abs=CM)


def test_on_the_boundary_is_not_outside_and_is_a_warning_at_zero() -> None:
    corner = SQUARE[2]
    on_corner = Geodetic(latitude_deg=corner[1], longitude_deg=corner[0])
    found = judged(SQUARE, on_corner, 30.0)
    assert found.verdict is Verdict.WARNING
    assert found.distance_to_boundary_m == 0.0
    assert found.distance_outside_m is None


def test_one_metre_outside_is_outside_by_one_metre() -> None:
    found = judged(SQUARE, at(51.0, 0.0), 30.0)
    assert found.verdict is Verdict.OUTSIDE
    assert found.distance_outside_m == pytest.approx(1.0, abs=CM)
    assert found.distance_to_boundary_m is None
    assert found.above_ceiling_m is None


def test_above_the_ceiling_while_inside_the_polygon_is_outside_by_the_height() -> None:
    found = judged(SQUARE, at(0.0, 0.0), CEILING_M + 10.0)
    assert found.verdict is Verdict.OUTSIDE
    assert found.above_ceiling_m == pytest.approx(10.0, abs=CM)
    assert found.distance_outside_m == pytest.approx(10.0, abs=CM)
    assert found.distance_to_boundary_m is None


def test_outside_and_above_reports_the_horizontal_distance_and_the_height() -> None:
    found = judged(SQUARE, at(61.0, 0.0), CEILING_M + 15.0)
    assert found.verdict is Verdict.OUTSIDE
    assert found.distance_outside_m == pytest.approx(11.0, abs=CM)
    assert found.above_ceiling_m == pytest.approx(15.0, abs=CM)


def test_a_height_exactly_at_the_ceiling_is_not_above_it() -> None:
    found = judged(SQUARE, at(0.0, 0.0), CEILING_M)
    assert found.verdict is Verdict.INSIDE
    assert found.above_ceiling_m is None


def test_the_notch_of_a_u_is_outside_though_inside_the_hull() -> None:
    notch = judged(U, at(50.0, 80.0), 30.0)
    assert notch.verdict is Verdict.OUTSIDE
    assert notch.distance_outside_m == pytest.approx(20.0, abs=CM)
    arm = judged(U, at(15.0, 60.0), 30.0)
    assert arm.verdict is Verdict.INSIDE
    assert arm.distance_to_boundary_m == pytest.approx(15.0, abs=CM)


def test_a_missing_height_is_unknown_never_inside() -> None:
    found = judged(SQUARE, at(0.0, 0.0), None)
    assert found.verdict is Verdict.UNKNOWN
    assert found.distance_outside_m is None
    assert found.distance_to_boundary_m is None
    assert found.above_ceiling_m is None
    assert "the height is missing" in found.reason


@pytest.mark.parametrize(
    "position",
    [
        None,
        Geodetic(math.nan, FARM.longitude_deg),
        Geodetic(FARM.latitude_deg, math.inf),
        Geodetic(91.0, FARM.longitude_deg),
        Geodetic(FARM.latitude_deg, -181.0),
    ],
    ids=[
        "missing",
        "nan latitude",
        "infinite longitude",
        "latitude above 90",
        "longitude below -180",
    ],
)
def test_a_position_that_is_missing_or_not_one_is_unknown_never_inside(
    position: Geodetic | None,
) -> None:
    found = judged(SQUARE, position, 30.0)
    assert found.verdict is Verdict.UNKNOWN
    assert found.distance_outside_m is None
    assert found.distance_to_boundary_m is None
    assert found.above_ceiling_m is None


@pytest.mark.parametrize("height_m", [math.nan, math.inf, -math.inf], ids=["nan", "inf", "-inf"])
def test_a_height_that_is_not_finite_is_unknown(height_m: float) -> None:
    assert judged(SQUARE, at(0.0, 0.0), height_m).verdict is Verdict.UNKNOWN


def test_a_breach_the_position_proves_stays_outside_when_the_height_is_missing() -> None:
    found = judged(SQUARE, at(51.0, 0.0), None)
    assert found.verdict is Verdict.OUTSIDE
    assert found.distance_outside_m == pytest.approx(1.0, abs=CM)
    assert found.above_ceiling_m is None
    assert found.reason == "outside the polygon by 1.0 m; the height is missing"


def test_a_height_above_the_ceiling_stays_outside_when_the_position_is_missing() -> None:
    found = judged(SQUARE, None, CEILING_M + 10.0)
    assert found.verdict is Verdict.OUTSIDE
    assert found.distance_outside_m == pytest.approx(10.0, abs=CM)
    assert found.above_ceiling_m == pytest.approx(10.0, abs=CM)


def test_a_ring_clockwise_or_anticlockwise_gives_the_same_verdicts() -> None:
    clockwise = list(reversed(U))
    cases = [
        (50.0, 80.0, 30.0),
        (15.0, 60.0, 30.0),
        (71.0, 29.0, 30.0),
        (50.0, 26.0, 30.0),
        (-1.0, 50.0, 30.0),
        (101.0, 50.0, 30.0),
        (15.0, 60.0, CEILING_M + 5.0),
    ]
    for east, north, height_m in cases:
        one = judged(U, at(east, north), height_m)
        other = judged(clockwise, at(east, north), height_m)
        assert other.verdict is one.verdict, (east, north, height_m)
        assert same(other.distance_outside_m, one.distance_outside_m)
        assert same(other.distance_to_boundary_m, one.distance_to_boundary_m)
        assert same(other.above_ceiling_m, one.above_ceiling_m)


def test_the_band_includes_its_own_edge_and_a_hair_beyond_it_is_inside() -> None:
    edge = judged(SQUARE, at(48.0, 0.0), 30.0).distance_to_boundary_m
    assert edge is not None
    assert judged(SQUARE, at(48.0, 0.0), 30.0, band_m=edge).verdict is Verdict.WARNING
    assert judged(SQUARE, at(48.0, 0.0), 30.0, band_m=edge - 1e-9).verdict is Verdict.INSIDE


def test_a_zero_band_warns_only_on_the_line() -> None:
    assert judged(SQUARE, at(0.0, 0.0), 30.0, band_m=0.0).verdict is Verdict.INSIDE
    corner = SQUARE[2]
    on_corner = Geodetic(latitude_deg=corner[1], longitude_deg=corner[0])
    assert judged(SQUARE, on_corner, 30.0, band_m=0.0).verdict is Verdict.WARNING


@pytest.mark.parametrize(
    ("ring", "rule"),
    [
        (stored((-50.0, -50.0), (50.0, 50.0), (50.0, -50.0), (-50.0, 50.0)), "edges_meet"),
        ([*SQUARE, SQUARE[0]], "zero_length_edge"),
        ([SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[2], SQUARE[3]], "zero_length_edge"),
        (SQUARE[:2], "too_few_vertices"),
    ],
    ids=["bow-tie", "closed ring", "repeated vertex", "two positions"],
)
def test_a_ring_that_is_not_a_simple_polygon_is_refused_never_judged(
    ring: list[list[float]], rule: str
) -> None:
    with pytest.raises(ValueError, match=rule):
        judged(ring, at(0.0, 0.0), 30.0)


@pytest.mark.parametrize("ceiling_m", [0.0, -5.0, math.nan, math.inf])
def test_a_ceiling_that_is_not_finite_and_above_zero_is_refused(ceiling_m: float) -> None:
    with pytest.raises(ValueError, match="ceiling"):
        judged(SQUARE, at(0.0, 0.0), 30.0, ceiling_m=ceiling_m)


@pytest.mark.parametrize("band_m", [-1.0, math.nan, math.inf])
def test_a_band_that_is_negative_or_not_finite_is_refused(band_m: float) -> None:
    with pytest.raises(ValueError, match="band"):
        judged(SQUARE, at(0.0, 0.0), 30.0, band_m=band_m)


def test_an_origin_that_is_not_a_position_is_refused() -> None:
    with pytest.raises(ValueError, match="out of range"):
        geofence_of(Geodetic(math.nan, 0.0), SQUARE, CEILING_M)


def test_the_judgement_is_frozen_and_the_verdicts_are_the_words_of_the_contract() -> None:
    found = judged(SQUARE, at(0.0, 0.0), 30.0)
    with pytest.raises(dataclasses.FrozenInstanceError):
        found.verdict = Verdict.OUTSIDE  # type: ignore[misc]
    assert [verdict.value for verdict in Verdict] == ["inside", "warning", "outside", "unknown"]


@pytest.mark.parametrize("ring", [U, star(64)], ids=["u", "star of 64"])
def test_the_verdicts_and_distances_agree_with_shapely_at_seeded_points(
    ring: list[list[float]],
) -> None:
    rng = random.Random(2026)  # noqa: S311 - seeded samples, not a secret
    fence = geofence_of(FARM, ring, CEILING_M)
    shape = Polygon(on_plane(ring))
    seen: set[Verdict] = set()
    judged_count = 0
    for _ in range(600):
        position = at(rng.uniform(-80.0, 120.0), rng.uniform(-80.0, 120.0))
        placed = east_north(FARM, position)
        spot = ShapelyPoint(placed.east_m, placed.north_m)
        gap = shape.exterior.distance(spot)
        if gap < 1e-3:
            continue  # within a millimetre of the boundary, no decision is measured
        height_m = rng.uniform(0.0, 150.0)
        found = judge(fence, position, height_m, BAND_M)
        inside = shape.contains(spot)
        above = height_m > CEILING_M
        if not inside or above:
            expected = Verdict.OUTSIDE
        elif gap <= BAND_M:
            expected = Verdict.WARNING
        else:
            expected = Verdict.INSIDE
        assert found.verdict is expected, (placed, height_m)
        if expected is Verdict.OUTSIDE and not inside:
            assert found.distance_outside_m == pytest.approx(gap, abs=1e-6)
        if expected is Verdict.OUTSIDE and inside:
            assert found.distance_outside_m == pytest.approx(height_m - CEILING_M, abs=1e-6)
        if expected in (Verdict.INSIDE, Verdict.WARNING):
            assert found.distance_to_boundary_m == pytest.approx(gap, abs=1e-6)
        seen.add(found.verdict)
        judged_count += 1
    assert judged_count > 500
    assert seen == {Verdict.INSIDE, Verdict.WARNING, Verdict.OUTSIDE}
