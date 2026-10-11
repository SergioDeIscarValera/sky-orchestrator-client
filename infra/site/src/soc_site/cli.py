"""Fetch an organization's site sources once, then bake them into the console's assets.

Usage:
    soc-site fetch --latitude 41.6523 --longitude -4.7245 --half-size-m 1000 --sources DIR
    soc-site bake --sources DIR --out DIR
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from soc_geo.projection import Geodetic
from soc_site.bake import DEFAULT_TEXELS, DEFAULT_VERTICES, BakeError, bake
from soc_site.elevation import ElevationError
from soc_site.sources import fetch


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="soc-site", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fetching = commands.add_parser("fetch", help="download IGN's elevation and imagery once")
    fetching.add_argument("--latitude", type=float, required=True)
    fetching.add_argument("--longitude", type=float, required=True)
    fetching.add_argument("--half-size-m", type=float, default=1000.0)
    fetching.add_argument("--sources", type=Path, required=True)
    baking = commands.add_parser("bake", help="bake the fetched sources, offline")
    baking.add_argument("--sources", type=Path, required=True)
    baking.add_argument("--out", type=Path, required=True)
    baking.add_argument("--vertices", type=int, default=DEFAULT_VERTICES)
    baking.add_argument("--texels", type=int, default=DEFAULT_TEXELS)
    arguments = parser.parse_args(argv)

    try:
        if arguments.command == "fetch":
            provenance = fetch(
                Geodetic(arguments.latitude, arguments.longitude),
                arguments.half_size_m,
                arguments.sources,
            )
            for name in ("elevation", "imagery"):
                entry = provenance[name]
                print(f"{name}: {entry['bytes']} bytes, sha256 {entry['sha256']}")
        else:
            model = bake(arguments.sources, arguments.out, arguments.vertices, arguments.texels)
            elevation, imagery = model["elevation"], model["imagery"]
            print(
                f"elevation {elevation['vertices']}² from {elevation['minimum_m']} m "
                f"to {elevation['maximum_m']} m, sha256 {elevation['sha256']}"
            )
            print(f"imagery {imagery['texels']}², sha256 {imagery['sha256']}")
    except (OSError, BakeError, ElevationError, ValueError) as error:
        print(f"soc-site {arguments.command}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
