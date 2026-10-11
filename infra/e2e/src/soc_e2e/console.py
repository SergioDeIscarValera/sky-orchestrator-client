"""The console as the mini-PC serves it, and Chrome working it.

`serving` runs the soc-web image, pointed at the platform's Kong. `Browser` runs
`apps/soc-web/scripts/e2e/console.mjs` and speaks its JSON lines: what the browser
saw comes in on its stdout, the harness's news goes out on its stdin.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import socket
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

from soc_check import ROOT, Image

WEB = ROOT / "apps" / "soc-web"
DRIVER = WEB / "scripts" / "e2e" / "console.mjs"
IN_THE_CONTAINER = "/etc/soc/soc-web.json"
SETTINGS = {
    "telemetry_stale_after_ms": 3000,
    "telemetry_lost_after_ms": 10000,
    "geofence_warning_band_m": 5,
    "geofence_max_vertices": 32,
    "max_arc_spacing_m": 10,
}
SERVED_WITHIN_S = 60
DRIVER_WAIT_S = 120
STOPPED_WITHIN_S = 10


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def _answers(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as answer:  # noqa: S310 - our container
            return bool(answer.status == 200)
    except urllib.error.URLError, ConnectionError, TimeoutError:
        return False


@contextmanager
def serving(image: Image, supabase_url: str, anon_key: str, directory: Path) -> Iterator[str]:
    """The console's image on 127.0.0.1, configured as soc-web.sh expects; its address."""
    settings = directory / "soc-web.json"
    settings.write_text(json.dumps(SETTINGS, indent=2) + "\n", encoding="utf-8")
    settings.chmod(0o644)
    directory.chmod(0o755)
    port = _free_port()
    container = image.start(
        f"soc-e2e-web-{secrets.token_hex(3)}",
        {
            "SOC_WEB_SUPABASE_URL": supabase_url,
            "SOC_WEB_SUPABASE_KEY": anon_key,
            "SOC_CONFIG_FILE": IN_THE_CONTAINER,
        },
        # A tmpfs in the container, as compose mounts it, not a path on this machine.
        "--tmpfs", "/tmp:size=4m",  # noqa: S108
        "-v", f"{settings}:{IN_THE_CONTAINER}:ro",
        "-p", f"127.0.0.1:{port}:8080",
        network="bridge",
    )  # fmt: skip
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + SERVED_WITHIN_S
        while not _answers(f"{url}/config.json"):
            if time.monotonic() > deadline:
                raise TimeoutError(f"the console did not answer within {SERVED_WITHIN_S} s")
            time.sleep(0.5)
        yield url
    finally:
        container.remove()


class Browser:
    """The driver's process: its lines in, the harness's out."""

    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self._process = process

    async def expect(self, event: str, within_s: float = DRIVER_WAIT_S) -> dict[str, Any]:
        """The driver's next line, which must be `event`; its failure is raised."""
        assert self._process.stdout is not None
        async with asyncio.timeout(within_s):
            raw = await self._process.stdout.readline()
        if not raw:
            raise RuntimeError(f"the browser stopped before {event}")
        line: dict[str, Any] = json.loads(raw)
        if line["event"] != event:
            raise RuntimeError(f"the browser said {line} where {event} was due")
        return line

    async def tell(self, **news: Any) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write((json.dumps(news) + "\n").encode())
        await self._process.stdin.drain()


@asynccontextmanager
async def browsing(environment: Mapping[str, str]) -> AsyncIterator[Browser]:
    """Starts the driver with its SOC_E2E_* settings; stops it on the way out."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("the console end to end needs Node, with apps/soc-web installed")
    process = await asyncio.create_subprocess_exec(
        node, str(DRIVER), cwd=WEB,
        env={**os.environ, **environment},
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )  # fmt: skip
    try:
        yield Browser(process)
    finally:
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), STOPPED_WITHIN_S)
        except TimeoutError:
            process.kill()
            await process.wait()
