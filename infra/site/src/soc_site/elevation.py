"""IGN's MDT as the WCS answers it, and its heights anywhere inside it (ADR-0018).

The WCS 2.0 answer is multipart: the ArcGrid part starts at its `ncols` line and
ends at the next MIME boundary. Its cells are square in degrees of ETRS89, which
SOC reads as WGS84: the two differ by under a metre in 2026, below the 5 m grid.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

HEADER_KEYS = ("ncols", "nrows", "xllcorner", "yllcorner", "cellsize")


class ElevationError(ValueError):
    """The coverage cannot be read, or a point lies outside it."""


@dataclass(frozen=True)
class Coverage:
    """Heights on a grid of square cells in degrees, rows from north to south."""

    west_deg: float
    south_deg: float
    cell_deg: float
    heights_m: npt.NDArray[np.float64]

    @property
    def north_deg(self) -> float:
        return self.south_deg + int(self.heights_m.shape[0]) * self.cell_deg

    @property
    def east_deg(self) -> float:
        return self.west_deg + int(self.heights_m.shape[1]) * self.cell_deg


def read_arcgrid(payload: bytes) -> Coverage:
    """The ArcGrid in a WCS answer, multipart or bare."""
    start = payload.find(b"ncols")
    if start == -1:
        raise ElevationError("the answer holds no ArcGrid: no ncols line")
    text = payload[start:]
    boundary = text.find(b"\n--")
    if boundary != -1:
        text = text[:boundary]
    lines = text.decode("ascii").split("\n")
    header: dict[str, float] = {}
    for line in lines[: len(HEADER_KEYS) + 1]:
        parts = line.split()
        if len(parts) == 2 and parts[0].lower() in (*HEADER_KEYS, "nodata_value"):
            header[parts[0].lower()] = float(parts[1])
    missing = [key for key in HEADER_KEYS if key not in header]
    if missing:
        raise ElevationError(f"the ArcGrid header lacks {', '.join(missing)}")
    columns, rows = int(header["ncols"]), int(header["nrows"])
    body = " ".join(lines[len(header) :]).split()
    if len(body) != columns * rows:
        raise ElevationError(f"the ArcGrid holds {len(body)} values for {rows} by {columns}")
    heights = np.array(body, dtype=np.float64).reshape(rows, columns)
    if "nodata_value" in header:
        heights[heights == header["nodata_value"]] = np.nan
    return Coverage(header["xllcorner"], header["yllcorner"], header["cellsize"], heights)


def sample(
    coverage: Coverage,
    latitude_deg: npt.NDArray[np.float64],
    longitude_deg: npt.NDArray[np.float64],
) -> npt.NDArray[np.float64]:
    """Heights at the points, bilinear between cell centres; refuses a point outside them."""
    rows, columns = coverage.heights_m.shape
    x = (longitude_deg - coverage.west_deg) / coverage.cell_deg - 0.5
    y = (coverage.north_deg - latitude_deg) / coverage.cell_deg - 0.5
    if x.min() < 0 or y.min() < 0 or x.max() > columns - 1 or y.max() > rows - 1:
        raise ElevationError("a point lies outside the coverage's cell centres")
    return bilinear(coverage.heights_m, x, y)


def bilinear(
    grid: npt.NDArray[np.float64], x: npt.NDArray[np.float64], y: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    """`grid` at fractional column `x` and row `y`, both within its extent."""
    rows, columns = grid.shape
    x0 = np.clip(np.floor(x).astype(np.int64), 0, columns - 2)
    y0 = np.clip(np.floor(y).astype(np.int64), 0, rows - 2)
    fx, fy = x - x0, y - y0
    top = grid[y0, x0] * (1 - fx) + grid[y0, x0 + 1] * fx
    bottom = grid[y0 + 1, x0] * (1 - fx) + grid[y0 + 1, x0 + 1] * fx
    result: npt.NDArray[np.float64] = top * (1 - fy) + bottom * fy
    return result
