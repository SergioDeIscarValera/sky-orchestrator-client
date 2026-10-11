from __future__ import annotations

import io
import json
import math
import random
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jsonschema_rs
import numpy as np
import pytest
from PIL import Image

from soc_geo import projection
from soc_site import bake as baking
from soc_site.bake import BakeError, bake, east_north, geodetic_at, hillshade
from soc_site.cli import main
from soc_site.elevation import Coverage, ElevationError, read_arcgrid, sample
from soc_site.sources import (
    ATTRIBUTION,
    IMAGERY_PX,
    Bounds,
    bounds_of,
    download,
    elevation_url,
    fetch,
    imagery_url,
)

FARM = projection.Geodetic(41.6523, -4.7245)
CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "site" / "site.schema.json"
CELL_DEG = 0.000045


def height_at(latitude: Any, longitude: Any) -> Any:
    """A plane that leans east and north, so bilinear sampling of it is exact."""
    return (
        690.0 + (latitude - FARM.latitude_deg) * 1000.0 + (longitude - FARM.longitude_deg) * 500.0
    )


def arcgrid(
    bounds: Bounds, multipart: bool = True, nodata_at: tuple[int, int] | None = None
) -> bytes:
    columns = math.ceil((bounds.east_deg - bounds.west_deg) / CELL_DEG) + 2
    rows = math.ceil((bounds.north_deg - bounds.south_deg) / CELL_DEG) + 2
    west, south = bounds.west_deg - CELL_DEG, bounds.south_deg - CELL_DEG
    centres_lon = west + (np.arange(columns) + 0.5) * CELL_DEG
    centres_lat = south + (rows - np.arange(rows) - 0.5) * CELL_DEG
    heights = height_at(centres_lat[:, None], centres_lon[None, :])
    if nodata_at is not None:
        heights[nodata_at] = -9999
    body = "\n".join(" ".join(f"{value:.3f}" for value in row) for row in heights)
    grid = (
        f"ncols {columns}\nnrows {rows}\nxllcorner {west:.12f}\nyllcorner {south:.12f}\n"
        f"cellsize {CELL_DEG:.12f}\nNODATA_value -9999\n{body}\n"
    )
    if not multipart:
        return grid.encode()
    return (
        "\n--wcs\nContent-Type: text/xml\n\n<coverage/>\n--wcs\nContent-Type: application/asc\n"
        f"Content-ID: coverage/out.asc\n\n{grid}--wcs--\n"
    ).encode()


def imagery(size: int = IMAGERY_PX) -> bytes:
    """Brighter towards the east: column c has the value c scaled to 0..255."""
    columns = np.linspace(0, 255, size)
    picture = Image.fromarray(np.tile(columns, (size, 1)).astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    picture.convert("RGB").save(buffer, format="PNG")
    return buffer.getvalue()


def fake_get(answers: dict[str, bytes]) -> Any:
    def get(url: str) -> bytes:
        return answers["elevation" if "WCS" in url else "imagery"]

    return get


def fetched(directory: Path, half_size_m: float = 300.0, **answers: bytes) -> Path:
    bounds = bounds_of(FARM, half_size_m)
    defaults = {"elevation": arcgrid(bounds), "imagery": imagery(256)}
    fetch(
        FARM,
        half_size_m,
        directory,
        get=fake_get({**defaults, **answers}),
        now=lambda: datetime(2026, 10, 11, 18, 0, tzinfo=UTC),
    )
    return directory


class TestTheElevation:
    def test_a_wcs_answer_is_read_from_its_multipart_body(self) -> None:
        bounds = bounds_of(FARM, 100.0)
        multipart, bare = read_arcgrid(arcgrid(bounds)), read_arcgrid(arcgrid(bounds, False))
        assert multipart.heights_m.shape == bare.heights_m.shape
        assert np.array_equal(multipart.heights_m, bare.heights_m)
        assert multipart.cell_deg == pytest.approx(CELL_DEG)

    def test_a_missing_value_is_no_height_and_a_broken_grid_is_refused(self) -> None:
        coverage = read_arcgrid(arcgrid(bounds_of(FARM, 100.0), nodata_at=(3, 4)))
        assert math.isnan(coverage.heights_m[3, 4])
        with pytest.raises(ElevationError, match="no ArcGrid"):
            read_arcgrid(b"<ExceptionReport/>")
        with pytest.raises(ElevationError, match="holds 3 values"):
            read_arcgrid(b"ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n")

    def test_heights_between_cell_centres_are_bilinear_and_nothing_outside(self) -> None:
        coverage = read_arcgrid(arcgrid(bounds_of(FARM, 100.0)))
        latitude = np.array([FARM.latitude_deg, FARM.latitude_deg + 0.0003])
        longitude = np.array([FARM.longitude_deg, FARM.longitude_deg - 0.0004])
        assert sample(coverage, latitude, longitude) == pytest.approx(
            height_at(latitude, longitude), abs=1e-3
        )
        with pytest.raises(ElevationError, match="outside"):
            sample(coverage, np.array([FARM.latitude_deg + 1]), np.array([FARM.longitude_deg]))


class TestTheLocalFrame:
    def test_the_array_forms_are_soc_geos_closed_forms(self) -> None:
        generator = random.Random(20261011)  # noqa: S311 - a seeded sweep, not a secret
        for _ in range(200):
            east, north = generator.uniform(-2500, 2500), generator.uniform(-2500, 2500)
            expected = projection.geodetic_at(FARM, projection.EastNorth(east, north))
            latitude, longitude = geodetic_at(FARM, np.array([east]), np.array([north]))
            assert latitude[0] == pytest.approx(expected.latitude_deg, abs=1e-10)
            assert longitude[0] == pytest.approx(expected.longitude_deg, abs=1e-10)
            back_east, back_north = east_north(FARM, latitude, longitude)
            assert math.hypot(back_east[0] - east, back_north[0] - north) < 1e-6

    def test_the_bounds_enclose_the_whole_square(self) -> None:
        bounds = bounds_of(FARM, 1000.0)
        for east in (-1000.0, 1000.0):
            for north in (-1000.0, 1000.0):
                corner = projection.geodetic_at(FARM, projection.EastNorth(east, north))
                assert bounds.south_deg < corner.latitude_deg < bounds.north_deg
                assert bounds.west_deg < corner.longitude_deg < bounds.east_deg


class TestTheSources:
    def test_ign_is_asked_for_the_5_m_mdt_and_pnoa_over_the_bounds(self) -> None:
        bounds = Bounds(41.64, -4.74, 41.66, -4.71)
        elevation, picture = elevation_url(bounds), imagery_url(bounds)
        assert elevation.startswith("https://servicios.idee.es/wcs-inspire/mdt?")
        assert "COVERAGEID=Elevacion4258_5" in elevation
        assert "SUBSET=Lat(41.6400000,41.6600000)" in elevation
        assert "SUBSET=Long(-4.7400000,-4.7100000)" in elevation
        assert "FORMAT=application%2Fasc" in elevation
        assert picture.startswith("https://www.ign.es/wms-inspire/pnoa-ma?")
        assert "LAYERS=OI.OrthoimageCoverage" in picture
        assert "BBOX=41.6400000,-4.7400000,41.6600000,-4.7100000" in picture
        assert f"WIDTH={IMAGERY_PX}" in picture

    def test_a_source_that_is_not_https_is_refused(self) -> None:
        with pytest.raises(ValueError, match="not https"):
            download("http://example.org/mdt")

    def test_what_was_fetched_is_recorded_with_its_hash_and_licence(self, tmp_path: Path) -> None:
        fetched(tmp_path)
        provenance = json.loads((tmp_path / "sources.json").read_text())
        assert provenance["elevation"]["fetched_at"] == "2026-10-11T18:00:00+00:00"
        assert provenance["imagery"]["licence"] == "CC BY 4.0"
        assert provenance["attribution"] == ATTRIBUTION
        assert len(provenance["imagery"]["sha256"]) == 64


class TestTheBake:
    def test_the_same_sources_bake_the_same_bytes(self, tmp_path: Path) -> None:
        sources = fetched(tmp_path / "sources")
        bake(sources, tmp_path / "one", texels=256)
        bake(sources, tmp_path / "two", texels=256)
        for name in ("site.json", "elevation.f32", "imagery.png"):
            assert (tmp_path / "one" / name).read_bytes() == (tmp_path / "two" / name).read_bytes()

    def test_the_grid_holds_the_ground_on_the_local_frame(self, tmp_path: Path) -> None:
        model = bake(fetched(tmp_path / "sources"), tmp_path / "out", vertices=33, texels=256)
        raw = (tmp_path / "out" / "elevation.f32").read_bytes()
        heights = np.frombuffer(raw, dtype="<f4").reshape(33, 33)
        step = 2 * 300.0 / 32
        for row, column in ((0, 0), (16, 16), (32, 5), (7, 30)):
            east, north = -300.0 + column * step, 300.0 - row * step
            point = projection.geodetic_at(FARM, projection.EastNorth(east, north))
            expected = height_at(point.latitude_deg, point.longitude_deg)
            assert float(heights[row, column]) == pytest.approx(expected, abs=2e-3)
        assert model["elevation"]["at_origin_m"] == pytest.approx(690.0, abs=1e-3)
        assert model["elevation"]["spacing_m"] == pytest.approx(step)

    def test_the_imagery_keeps_west_on_the_left_and_east_on_the_right(self, tmp_path: Path) -> None:
        bake(fetched(tmp_path / "sources"), tmp_path / "out", texels=256)
        grey = np.asarray(Image.open(tmp_path / "out" / "imagery.png"))
        assert grey.shape == (256, 256)
        middle = grey[128]
        assert int(middle[10]) < int(middle[128]) < int(middle[245])
        assert np.all(np.diff(middle.astype(int)) >= -1)

    def test_the_model_follows_its_contract(self, tmp_path: Path) -> None:
        model = bake(fetched(tmp_path / "sources"), tmp_path / "out", texels=256)
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        jsonschema_rs.validator_for(contract).validate(model)
        assert model["attribution"] == ATTRIBUTION

    def test_a_source_changed_since_its_fetch_is_refused(self, tmp_path: Path) -> None:
        sources = fetched(tmp_path / "sources")
        (sources / "imagery.jpg").write_bytes(imagery(128))
        with pytest.raises(BakeError, match="not the file fetched"):
            bake(sources, tmp_path / "out", texels=256)

    def test_sources_that_do_not_cover_the_site_are_refused(self, tmp_path: Path) -> None:
        small = arcgrid(bounds_of(FARM, 50.0))
        with pytest.raises(BakeError, match="does not cover"):
            bake(fetched(tmp_path / "sources", elevation=small), tmp_path / "out", texels=256)

    def test_a_hole_in_the_elevation_is_refused(self, tmp_path: Path) -> None:
        holed = arcgrid(bounds_of(FARM, 300.0), nodata_at=(40, 40))
        with pytest.raises(BakeError, match="no data"):
            bake(fetched(tmp_path / "sources", elevation=holed), tmp_path / "out", texels=256)

    def test_a_site_over_its_loading_budget_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(baking, "BUDGET_BYTES", 1000)
        with pytest.raises(BakeError, match="NFR-PERF-05"):
            bake(fetched(tmp_path / "sources"), tmp_path / "out", texels=256)

    def test_slopes_facing_the_sun_are_lit_and_those_away_are_shaded(self) -> None:
        heights = np.zeros((9, 18))
        heights[:, :9] = np.arange(9)[None, :] * -1.0  # falls towards the east: faces east
        heights[:, 9:] = np.arange(9)[None, :] * 1.0  # rises towards the east: faces west
        coverage = Coverage(FARM.longitude_deg, FARM.latitude_deg, CELL_DEG, heights)
        shade = hillshade(coverage, FARM)
        assert shade[4, 13] > shade[4, 4]


class TestTheCommand:
    def test_bake_prints_the_assets_hashes_and_refuses_with_a_status(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        sources = fetched(tmp_path / "sources")
        status = main(
            ["bake", "--sources", str(sources), "--out", str(tmp_path / "out"), "--texels", "64"]
        )
        assert status == 0
        assert "imagery 64²" in capsys.readouterr().out
        assert (
            main(["bake", "--sources", str(sources), "--out", str(tmp_path), "--vertices", "4"])
            == 1
        )
        assert "vertices is an odd count" in capsys.readouterr().err
