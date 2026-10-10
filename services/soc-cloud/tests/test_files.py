from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator

import aiohttp
import pytest
from aiohttp import web

from soc_cloud.files import FileServer, FlightFileConflictError, FlightFiles

KMZ = b"PK\x03\x04" + bytes(range(256)) * 8
BASES = {"lab": "http://soc-cloud:8090/", "field": "http://soc-cloud.field:8090"}
GRACE_S = 600.0


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def files(clock: Clock) -> FlightFiles:
    return FlightFiles(BASES, GRACE_S, clock)


@pytest.fixture
async def served(files: FlightFiles) -> AsyncIterator[str]:
    runner = web.AppRunner(FileServer(files).application())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


async def fetch(url: str) -> tuple[int, bytes, str]:
    timeout = aiohttp.ClientTimeout(total=5)
    async with (
        aiohttp.ClientSession(timeout=timeout) as session,
        session.get(url, allow_redirects=False) as response,
    ):
        return response.status, await response.read(), response.content_type


def test_a_kept_file_is_offered_with_its_md5_at_an_unguessable_path(files: FlightFiles) -> None:
    kept = files.keep("flight-1", KMZ)
    offer = files.offer("lab", "flight-1")
    assert offer is not None
    assert offer.fingerprint == hashlib.md5(KMZ, usedforsecurity=False).hexdigest()
    assert offer.url == f"http://soc-cloud:8090/files/{kept.token}.kmz"
    assert len(bytes.fromhex(kept.token)) * 8 >= 128


def test_each_stack_is_offered_its_own_address(files: FlightFiles) -> None:
    files.keep("flight-1", KMZ)
    offer = files.offer("field", "flight-1")
    assert offer is not None
    assert offer.url.startswith("http://soc-cloud.field:8090/files/")


def test_tokens_differ_between_flights(files: FlightFiles) -> None:
    assert files.keep("flight-1", KMZ).token != files.keep("flight-2", KMZ).token


def test_an_unknown_flight_has_no_offer(files: FlightFiles) -> None:
    assert files.offer("lab", "flight-9") is None


def test_keeping_the_same_bytes_again_changes_nothing(files: FlightFiles) -> None:
    assert files.keep("flight-1", KMZ) == files.keep("flight-1", KMZ)


def test_a_flight_never_flies_other_bytes(files: FlightFiles) -> None:
    files.keep("flight-1", KMZ)
    with pytest.raises(FlightFileConflictError, match="flight-1"):
        files.keep("flight-1", KMZ + b"x")


def test_a_malformed_token_is_refused(files: FlightFiles) -> None:
    with pytest.raises(ValueError, match="hexadecimal"):
        files.keep("flight-1", KMZ, token="../../etc/passwd")


def test_a_finished_flight_is_served_until_its_grace_ends(files: FlightFiles, clock: Clock) -> None:
    kept = files.keep("flight-1", KMZ)
    files.finished("flight-1")
    clock.now += GRACE_S - 1
    assert files.served(kept.token) == kept
    clock.now += 1
    assert files.served(kept.token) is None
    assert files.offer("lab", "flight-1") is None


def test_the_bytes_and_the_token_never_show(files: FlightFiles) -> None:
    kept = files.keep("flight-1", KMZ)
    assert kept.token not in repr(kept)
    assert "PK" not in repr(kept)


async def test_the_dock_downloads_the_exact_bytes(files: FlightFiles, served: str) -> None:
    kept = files.keep("flight-1", KMZ)
    status, body, content_type = await fetch(f"{served}/files/{kept.token}.kmz")
    assert status == 200
    assert hashlib.md5(body, usedforsecurity=False).hexdigest() == kept.md5
    assert body == KMZ
    assert content_type == "application/vnd.google-earth.kmz"


async def test_every_other_path_is_the_same_404(files: FlightFiles, served: str) -> None:
    kept = files.keep("flight-1", KMZ)
    for path in (
        "/files/" + "0" * 32 + ".kmz",
        f"/files/{kept.token}",
        f"/files/{kept.token}.zip",
        f"/files/{kept.token.upper()}.kmz",
        "/files/",
        "/files/flight-1.kmz",
        "/",
        f"/{kept.token}.kmz",
    ):
        status, body, _ = await fetch(f"{served}{path}")
        assert status == 404, path
        assert KMZ not in body


async def test_a_retired_file_is_a_404(files: FlightFiles, clock: Clock, served: str) -> None:
    kept = files.keep("flight-1", KMZ)
    files.finished("flight-1")
    clock.now += GRACE_S
    assert (await fetch(f"{served}/files/{kept.token}.kmz"))[0] == 404
