#!/usr/bin/env python3
"""Vendor Sky Orchestrator's wire contracts, pinned by commit, and hold them there.

SOC speaks to Sky Orchestrator over the DJI Cloud API and so-wayline's HTTP API.
Their schemas live in Sky Orchestrator's repository; SOC keeps a copy at one
commit, byte for byte, with a SHA-256 per file, because a schema there can change
shape without its x-version moving.

`vendored.json` records where the files came from; `vendored.sha256` holds their
hashes in sha256sum's format, so `sha256sum -c vendored.sha256` checks them too.

Usage:
    vendor_sky_orchestrator.py --source ../sky-orchestrator --commit <sha>
    vendor_sky_orchestrator.py --check

Exit status: 0 when the vendored files equal the manifest, 1 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path, PurePosixPath

REPOSITORY = "https://github.com/SergioDeIscarValera/sky-orchestrator"
ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "contracts" / "sky-orchestrator"
PROVENANCE = "vendored.json"
CHECKSUMS = "vendored.sha256"
VENDORED_TREES = ("mqtt", "wayline")
SOURCE_PREFIX = PurePosixPath("contracts")
SOURCE_TREES = tuple(str(SOURCE_PREFIX / tree) for tree in VENDORED_TREES)


def wanted(path: PurePosixPath) -> bool:
    relative = path.relative_to(SOURCE_PREFIX)
    if relative.parts[0] == "mqtt":
        return "internal" not in relative.parts and relative.suffix == ".json"
    return relative == PurePosixPath("wayline/openapi.yaml")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(source: Path, *arguments: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(source), *arguments], capture_output=True, check=True
    ).stdout


def vendor(source: Path, commit: str, destination: Path = DESTINATION) -> dict[str, str]:
    resolved = git(source, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip()
    listed = git(source, "ls-tree", "-r", "--name-only", resolved, *SOURCE_TREES)
    paths = sorted(
        path for line in listed.decode().splitlines() if wanted(path := PurePosixPath(line))
    )
    for tree in VENDORED_TREES:
        shutil.rmtree(destination / tree, ignore_errors=True)
    files: dict[str, str] = {}
    for path in paths:
        data = git(source, "show", f"{resolved}:{path}")
        relative = path.relative_to(SOURCE_PREFIX)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[str(relative)] = sha256(data)
    committed = git(source, "show", "-s", "--format=%cs", resolved).decode().strip()
    described = git(source, "describe", "--tags", "--always", resolved).decode().strip()
    provenance = {
        "repository": REPOSITORY,
        "commit": resolved,
        "describe": described,
        "committed": committed,
    }
    (destination / PROVENANCE).write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (destination / CHECKSUMS).write_text(
        "".join(f"{digest}  {path}\n" for path, digest in files.items()), encoding="utf-8"
    )
    return files


def present(destination: Path) -> Iterable[str]:
    for tree in VENDORED_TREES:
        for path in sorted((destination / tree).rglob("*")):
            if path.is_file():
                yield path.relative_to(destination).as_posix()


def checksums(path: Path) -> dict[str, str]:
    digests: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        digests[name] = digest
    return digests


def problems(destination: Path = DESTINATION) -> list[str]:
    missing = [
        f"{(destination / name).relative_to(destination.parent)} is missing"
        for name in (PROVENANCE, CHECKSUMS)
        if not (destination / name).is_file()
    ]
    if missing:
        return missing
    expected = checksums(destination / CHECKSUMS)
    found = set(present(destination))
    found_problems = [f"{path} is not in the manifest" for path in sorted(found - set(expected))]
    for path, digest in sorted(expected.items()):
        if path not in found:
            found_problems.append(f"{path} is missing")
        elif sha256((destination / path).read_bytes()) != digest:
            found_problems.append(f"{path} differs from Sky Orchestrator's at the pinned commit")
    return found_problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="a clone of Sky Orchestrator")
    parser.add_argument("--commit", help="the commit to vendor")
    parser.add_argument("--check", action="store_true", help="verify the vendored files")
    arguments = parser.parse_args(argv)

    if arguments.check or arguments.source is None:
        found = problems()
        if found:
            print("Sky Orchestrator's vendored contracts disagree:", file=sys.stderr)
            for problem in found:
                print(f"  {problem}", file=sys.stderr)
            return 1
        print("Sky Orchestrator's vendored contracts equal the manifest.")
        return 0
    if not arguments.commit:
        parser.error("--source needs --commit")
    files = vendor(arguments.source, arguments.commit)
    print(f"Vendored {len(files)} files at {arguments.commit}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
