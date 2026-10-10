"""Flight files, kept in memory and served on Sky Orchestrator's network (ADR-0008).

Each flight's KMZ is kept as its exact bytes, under a path holding 128 random
bits, and offered to the dock with its MD5. The dock's `flighttask_resource_get`
is answered from memory, so its 1.5 s deadline never waits on the database. A
flight's file stops being served `flight_file_grace_s` after the flight ends
(NFR-SEC-06). Every other path answers 404, the same 404.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from aiohttp import web

import soc_log
from soc_cloud.link.stack import FileOffer
from soc_supervision import Health

TOKEN_BYTES = 16
TOKEN = re.compile(r"^[0-9a-f]{32}$")
SUFFIX = ".kmz"
KMZ = "application/vnd.google-earth.kmz"

log = soc_log.get(__name__)


class FlightFileConflictError(Exception):
    pass


@dataclass(frozen=True)
class FlightFile:
    flight_id: str
    content: bytes = field(repr=False)
    md5: str
    token: str = field(repr=False)


class FlightFiles:
    def __init__(
        self,
        base_urls: Mapping[str, str],
        grace_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._base_urls = {stack: url.rstrip("/") for stack, url in base_urls.items()}
        self._grace_s = grace_s
        self._clock = clock
        self._by_flight: dict[str, FlightFile] = {}
        self._by_token: dict[str, FlightFile] = {}
        self._retire_at: dict[str, float] = {}

    def keep(self, flight_id: str, content: bytes, token: str | None = None) -> FlightFile:
        md5 = hashlib.md5(content, usedforsecurity=False).hexdigest()
        kept = self._by_flight.get(flight_id)
        if kept is not None:
            if kept.md5 != md5:
                raise FlightFileConflictError(f"{flight_id} already flies other bytes")
            return kept
        chosen = token or secrets.token_hex(TOKEN_BYTES)
        if not TOKEN.match(chosen):
            raise ValueError("a token is 32 lower-case hexadecimal characters")
        file = FlightFile(flight_id, content, md5, chosen)
        self._by_flight[flight_id] = file
        self._by_token[chosen] = file
        return file

    def offer(self, stack: str, flight_id: str) -> FileOffer | None:
        file = self._live(self._by_flight.get(flight_id))
        if file is None:
            return None
        return FileOffer(f"{self._base_urls[stack]}/files/{file.token}{SUFFIX}", file.md5)

    def served(self, token: str) -> FlightFile | None:
        return self._live(self._by_token.get(token))

    def finished(self, flight_id: str) -> None:
        if flight_id in self._by_flight:
            self._retire_at[flight_id] = self._clock() + self._grace_s

    def _live(self, file: FlightFile | None) -> FlightFile | None:
        if file is None:
            return None
        retire_at = self._retire_at.get(file.flight_id)
        if retire_at is not None and self._clock() >= retire_at:
            self._forget(file)
            return None
        return file

    def _forget(self, file: FlightFile) -> None:
        self._by_flight.pop(file.flight_id, None)
        self._by_token.pop(file.token, None)
        self._retire_at.pop(file.flight_id, None)
        log.info("flight_file_retired", flight=file.flight_id)


class FileServer:
    def __init__(self, files: FlightFiles) -> None:
        self._files = files
        self._health = Health(up=False, since=time.monotonic(), error="not serving yet")

    @property
    def health(self) -> Health:
        return self._health

    def application(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/files/{name}", self._serve)
        app.on_startup.append(self._started)
        return app

    async def _started(self, _app: web.Application) -> None:
        self._health = Health(up=True, since=time.monotonic())

    async def _serve(self, request: web.Request) -> web.Response:
        name = request.match_info["name"]
        token = name.removesuffix(SUFFIX)
        file = self._files.served(token) if name.endswith(SUFFIX) and TOKEN.match(token) else None
        if file is None:
            raise web.HTTPNotFound
        log.info("flight_file_served", flight=file.flight_id, size_bytes=len(file.content))
        return web.Response(
            body=file.content,
            content_type=KMZ,
            headers={"Cache-Control": "no-store"},
        )
