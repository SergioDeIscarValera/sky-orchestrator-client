"""The site's sources, fetched once from IGN with their provenance (ADR-0018).

`fetch` is the only part that needs the internet. It writes the answers as they
came, with their SHA-256, URL and licence, into `sources.json`; `bake` then works
from those files alone, so the same sources always bake the same assets.
"""

from __future__ import annotations

import hashlib
import json
import math
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from soc_geo.projection import EastNorth, Geodetic, geodetic_at

SOURCES_FILE = "sources.json"
ELEVATION_FILE = "elevation.asc"
IMAGERY_FILE = "imagery.jpg"
#: Beyond the site's square, so every texel and vertex has neighbours to sample.
MARGIN_DEG = 0.0003
IMAGERY_PX = 2048

WCS = "https://servicios.idee.es/wcs-inspire/mdt"
WMS = "https://www.ign.es/wms-inspire/pnoa-ma"
LICENCE = "CC BY 4.0"
ATTRIBUTION = "MDT05 and PNOA © Instituto Geográfico Nacional de España, CC BY 4.0 (ign.es)"
TIMEOUT_S = 120


@dataclass(frozen=True)
class Bounds:
    """A rectangle in degrees enclosing the site's square, with its margin."""

    south_deg: float
    west_deg: float
    north_deg: float
    east_deg: float


def bounds_of(origin: Geodetic, half_size_m: float) -> Bounds:
    """The degrees the site's square covers: its corners and edge midpoints, plus the margin."""
    points = [
        geodetic_at(origin, EastNorth(east * half_size_m, north * half_size_m))
        for east in (-1, 0, 1)
        for north in (-1, 0, 1)
    ]
    return Bounds(
        south_deg=min(point.latitude_deg for point in points) - MARGIN_DEG,
        west_deg=min(point.longitude_deg for point in points) - MARGIN_DEG,
        north_deg=max(point.latitude_deg for point in points) + MARGIN_DEG,
        east_deg=max(point.longitude_deg for point in points) + MARGIN_DEG,
    )


def _degrees(value: float) -> str:
    return f"{value:.7f}"


def elevation_url(bounds: Bounds) -> str:
    """IGN's 5 m MDT over the bounds, as an ArcGrid in ETRS89 degrees."""
    query = [
        ("SERVICE", "WCS"),
        ("VERSION", "2.0.1"),
        ("REQUEST", "GetCoverage"),
        ("COVERAGEID", "Elevacion4258_5"),
        ("SUBSET", f"Lat({_degrees(bounds.south_deg)},{_degrees(bounds.north_deg)})"),
        ("SUBSET", f"Long({_degrees(bounds.west_deg)},{_degrees(bounds.east_deg)})"),
        ("FORMAT", "application/asc"),
    ]
    return f"{WCS}?{urllib.parse.urlencode(query, safe='(),')}"


def imagery_url(bounds: Bounds) -> str:
    """PNOA's orthophoto over the bounds, IMAGERY_PX square, axes latitude first (WMS 1.3.0)."""
    bbox = ",".join(
        _degrees(value)
        for value in (bounds.south_deg, bounds.west_deg, bounds.north_deg, bounds.east_deg)
    )
    query = [
        ("SERVICE", "WMS"),
        ("VERSION", "1.3.0"),
        ("REQUEST", "GetMap"),
        ("LAYERS", "OI.OrthoimageCoverage"),
        ("STYLES", ""),
        ("CRS", "EPSG:4258"),
        ("BBOX", bbox),
        ("WIDTH", str(IMAGERY_PX)),
        ("HEIGHT", str(IMAGERY_PX)),
        ("FORMAT", "image/jpeg"),
    ]
    return f"{WMS}?{urllib.parse.urlencode(query, safe=',:')}"


Download = Callable[[str], bytes]


def download(url: str) -> bytes:
    if not url.startswith("https://"):
        raise ValueError(f"refusing a source that is not https: {url}")
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as answer:  # noqa: S310 - https only
        body: bytes = answer.read()
    return body


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(
    origin: Geodetic,
    half_size_m: float,
    directory: Path,
    get: Download = download,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, Any]:
    """Fetches both sources into `directory` and writes their provenance."""
    if not (0 < half_size_m <= 5000) or not math.isfinite(half_size_m):
        raise ValueError(f"a site's half size is from 0 to 5000 m, not {half_size_m}")
    bounds = bounds_of(origin, half_size_m)
    directory.mkdir(parents=True, exist_ok=True)
    provenance: dict[str, Any] = {
        "schema_version": "1.0.0",
        "origin": {"latitude_deg": origin.latitude_deg, "longitude_deg": origin.longitude_deg},
        "half_size_m": half_size_m,
        "bounds": {
            "south_deg": bounds.south_deg,
            "west_deg": bounds.west_deg,
            "north_deg": bounds.north_deg,
            "east_deg": bounds.east_deg,
        },
    }
    for name, url, file in (
        ("elevation", elevation_url(bounds), ELEVATION_FILE),
        ("imagery", imagery_url(bounds), IMAGERY_FILE),
    ):
        body = get(url)
        (directory / file).write_bytes(body)
        provenance[name] = {
            "url": url,
            "file": file,
            "sha256": sha256(body),
            "bytes": len(body),
            "fetched_at": now().isoformat(timespec="seconds"),
            "licence": LICENCE,
        }
    provenance["attribution"] = ATTRIBUTION
    (directory / SOURCES_FILE).write_text(
        json.dumps(provenance, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return provenance
