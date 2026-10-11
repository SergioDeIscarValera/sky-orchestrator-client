"""Bakes a site model from its fetched sources, offline and deterministic (FR-DEP-05).

The elevation grid and the imagery are both laid on the organization's local frame
(ADR-0009): a square twice `half_size_m` across, rows from north to south, columns from
west to east. The imagery is PNOA's luminance with the terrain's hillshade baked
in, which the scene tints per theme (ADR-0018, the design system). The same
sources bake the same bytes, and a site over NFR-PERF-05's 8 MB is refused.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
from PIL import Image

from soc_geo.projection import ECCENTRICITY_SQUARED, SEMI_MAJOR_AXIS_M, Geodetic
from soc_site.elevation import Coverage, ElevationError, bilinear, read_arcgrid, sample
from soc_site.sources import SOURCES_FILE, sha256

SITE_FILE = "site.json"
ELEVATION_OUT = "elevation.f32"
IMAGERY_OUT = "imagery.png"
DEFAULT_VERTICES = 257
MAX_VERTICES = 513
DEFAULT_TEXELS = 2048
MAX_TEXELS = 2048
#: How much of the imagery's brightness the hillshade takes; the rest is PNOA's.
SHADE_SHARE = 0.45
SUN_AZIMUTH_DEG = 315.0
SUN_ALTITUDE_DEG = 45.0
#: NFR-PERF-05: the site model's assets.
BUDGET_BYTES = 8 * 1024 * 1024
VERSION = "0.1.0"

Array = npt.NDArray[np.float64]


class BakeError(ValueError):
    """The sources cannot bake a site SOC would trust."""


@dataclass(frozen=True)
class Site:
    origin: Geodetic
    half_size_m: float


def _earth_centred(latitude_deg: Array, longitude_deg: Array) -> tuple[Array, Array, Array]:
    latitude, longitude = np.radians(latitude_deg), np.radians(longitude_deg)
    sine = np.sin(latitude)
    prime_vertical = SEMI_MAJOR_AXIS_M / np.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
    return (
        prime_vertical * np.cos(latitude) * np.cos(longitude),
        prime_vertical * np.cos(latitude) * np.sin(longitude),
        prime_vertical * (1 - ECCENTRICITY_SQUARED) * sine,
    )


def east_north(origin: Geodetic, latitude_deg: Array, longitude_deg: Array) -> tuple[Array, Array]:
    """soc_geo's closed form over arrays: the same formula, held equal to it by a test."""
    ox, oy, oz = _earth_centred(np.array(origin.latitude_deg), np.array(origin.longitude_deg))
    px, py, pz = _earth_centred(latitude_deg, longitude_deg)
    dx, dy, dz = px - ox, py - oy, pz - oz
    latitude, longitude = np.radians(origin.latitude_deg), np.radians(origin.longitude_deg)
    east = -np.sin(longitude) * dx + np.cos(longitude) * dy
    north = (
        -np.sin(latitude) * np.cos(longitude) * dx
        - np.sin(latitude) * np.sin(longitude) * dy
        + np.cos(latitude) * dz
    )
    return east, north


def geodetic_at(origin: Geodetic, east_m: Array, north_m: Array) -> tuple[Array, Array]:
    """soc_geo's inverse over arrays: Newton's method from the radii at the origin."""
    latitude = np.radians(origin.latitude_deg)
    sine = np.sin(latitude)
    meridian = (
        SEMI_MAJOR_AXIS_M * (1 - ECCENTRICITY_SQUARED) / (1 - ECCENTRICITY_SQUARED * sine**2) ** 1.5
    )
    prime_vertical = SEMI_MAJOR_AXIS_M / np.sqrt(1 - ECCENTRICITY_SQUARED * sine**2)
    per_degree_north = np.radians(1) * meridian
    per_degree_east = np.radians(1) * prime_vertical * np.cos(latitude)
    lat = origin.latitude_deg + north_m / per_degree_north
    lon = origin.longitude_deg + east_m / per_degree_east
    for _ in range(8):
        east, north = east_north(origin, lat, lon)
        lat = lat + (north_m - north) / per_degree_north
        lon = lon + (east_m - east) / per_degree_east
    east, north = east_north(origin, lat, lon)
    if float(np.max(np.hypot(east - east_m, north - north_m))) > 1e-6:
        raise BakeError("the local frame's inverse does not converge over the site")
    return lat, lon


def local_grid(site: Site, count: int, centred: bool) -> tuple[Array, Array]:
    """The local frame's points over the site's square, rows north to south.

    Vertices (`centred` false) run edge to edge; texels (`centred` true) sit at the
    centres of `count` equal cells.
    """
    span = 2 * site.half_size_m
    if centred:
        steps = (np.arange(count) + 0.5) * span / count - site.half_size_m
    else:
        steps = np.arange(count) * span / (count - 1) - site.half_size_m
    east, north = np.meshgrid(steps, steps[::-1])
    return geodetic_at(site.origin, east, north)


def hillshade(coverage: Coverage, origin: Geodetic) -> Array:
    """Light from the north-west, 45° up, on the coverage's own cells: 0 dark to 1 lit."""
    latitude = np.radians(origin.latitude_deg)
    sine = np.sin(latitude)
    meridian = (
        SEMI_MAJOR_AXIS_M * (1 - ECCENTRICITY_SQUARED) / (1 - ECCENTRICITY_SQUARED * sine**2) ** 1.5
    )
    prime_vertical = SEMI_MAJOR_AXIS_M / np.sqrt(1 - ECCENTRICITY_SQUARED * sine**2)
    cell_north_m = np.radians(coverage.cell_deg) * meridian
    cell_east_m = np.radians(coverage.cell_deg) * prime_vertical * np.cos(latitude)
    heights = np.where(
        np.isnan(coverage.heights_m), np.nanmean(coverage.heights_m), coverage.heights_m
    )
    per_row, per_column = np.gradient(heights, cell_north_m, cell_east_m)
    rise_east, rise_north = per_column, -per_row
    azimuth, altitude = np.radians(SUN_AZIMUTH_DEG), np.radians(SUN_ALTITUDE_DEG)
    light = (
        np.sin(azimuth) * np.cos(altitude),
        np.cos(azimuth) * np.cos(altitude),
        np.sin(altitude),
    )
    lit = (-rise_east * light[0] - rise_north * light[1] + light[2]) / np.sqrt(
        1 + rise_east**2 + rise_north**2
    )
    shade: Array = np.clip(lit, 0.0, 1.0)
    return shade


def _verified(directory: Path, entry: dict[str, Any]) -> bytes:
    data = (directory / str(entry["file"])).read_bytes()
    if sha256(data) != entry["sha256"]:
        raise BakeError(f"{entry['file']} is not the file fetched: its SHA-256 differs")
    return data


def bake(
    sources: Path,
    out: Path,
    vertices: int = DEFAULT_VERTICES,
    texels: int = DEFAULT_TEXELS,
) -> dict[str, Any]:
    """Bakes `sources` into `out`: site.json, elevation.f32 and imagery.png."""
    if not (3 <= vertices <= MAX_VERTICES and vertices % 2 == 1):
        raise BakeError(f"vertices is an odd count from 3 to {MAX_VERTICES}, not {vertices}")
    if not (16 <= texels <= MAX_TEXELS):
        raise BakeError(f"texels is from 16 to {MAX_TEXELS}, not {texels}")
    provenance = json.loads((sources / SOURCES_FILE).read_text(encoding="utf-8"))
    site = Site(
        Geodetic(provenance["origin"]["latitude_deg"], provenance["origin"]["longitude_deg"]),
        float(provenance["half_size_m"]),
    )
    coverage = read_arcgrid(_verified(sources, provenance["elevation"]))

    latitude, longitude = local_grid(site, vertices, centred=False)
    try:
        heights = sample(coverage, latitude, longitude)
    except ElevationError as error:
        raise BakeError(f"the elevation does not cover the site: {error}") from error
    if np.isnan(heights).any():
        raise BakeError("the elevation has no data over part of the site")

    picture = Image.open(io.BytesIO(_verified(sources, provenance["imagery"]))).convert("L")
    luminance = np.asarray(picture, dtype=np.float64)
    bounds = provenance["bounds"]
    texel_lat, texel_lon = local_grid(site, texels, centred=True)
    height_px, width_px = luminance.shape
    x = (texel_lon - bounds["west_deg"]) / (
        bounds["east_deg"] - bounds["west_deg"]
    ) * width_px - 0.5
    y = (bounds["north_deg"] - texel_lat) / (
        bounds["north_deg"] - bounds["south_deg"]
    ) * height_px - 0.5
    if x.min() < 0 or y.min() < 0 or x.max() > width_px - 1 or y.max() > height_px - 1:
        raise BakeError("the imagery does not cover the site")
    shade_x = (texel_lon - coverage.west_deg) / coverage.cell_deg - 0.5
    shade_y = (coverage.north_deg - texel_lat) / coverage.cell_deg - 0.5
    shade = bilinear(hillshade(coverage, site.origin), shade_x, shade_y)
    baked = bilinear(luminance, x, y) * (1 - SHADE_SHARE + SHADE_SHARE * shade)
    grey = np.clip(np.rint(baked), 0, 255).astype(np.uint8)

    out.mkdir(parents=True, exist_ok=True)
    elevation_bytes = heights.astype("<f4").tobytes()
    image_buffer = io.BytesIO()
    Image.fromarray(grey, mode="L").save(image_buffer, format="PNG", compress_level=9)
    imagery_bytes = image_buffer.getvalue()
    total = len(elevation_bytes) + len(imagery_bytes)
    if total > BUDGET_BYTES:
        raise BakeError(f"the site's assets take {total} bytes, over NFR-PERF-05's {BUDGET_BYTES}")

    centre = vertices // 2
    model: dict[str, Any] = {
        "schema_version": "1.0.0",
        "origin": provenance["origin"],
        "frame": "the east-north tangent plane at the origin, WGS84 (ADR-0009, ADR-0014)",
        "half_size_m": site.half_size_m,
        "elevation": {
            "file": ELEVATION_OUT,
            "encoding": "float32 little-endian, rows north to south, columns west to east",
            "vertices": vertices,
            "spacing_m": 2 * site.half_size_m / (vertices - 1),
            "minimum_m": round(float(heights.min()), 3),
            "maximum_m": round(float(heights.max()), 3),
            "at_origin_m": round(float(heights[centre, centre]), 3),
            "sha256": sha256(elevation_bytes),
        },
        "imagery": {
            "file": IMAGERY_OUT,
            "encoding": "8-bit luminance, PNG, rows north to south, the hillshade baked in",
            "texels": texels,
            "shade_share": SHADE_SHARE,
            "sun": {"azimuth_deg": SUN_AZIMUTH_DEG, "altitude_deg": SUN_ALTITUDE_DEG},
            "sha256": sha256(imagery_bytes),
        },
        "sources": {
            name: {key: provenance[name][key] for key in ("url", "sha256", "fetched_at", "licence")}
            for name in ("elevation", "imagery")
        },
        "attribution": provenance["attribution"],
        "baked_by": f"soc-site {VERSION}",
    }
    (out / ELEVATION_OUT).write_bytes(elevation_bytes)
    (out / IMAGERY_OUT).write_bytes(imagery_bytes)
    (out / SITE_FILE).write_text(
        json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return model
