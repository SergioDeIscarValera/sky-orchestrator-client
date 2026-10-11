from __future__ import annotations

import base64
import gzip
import http.client
import json
import secrets
import socket
from collections.abc import Iterator
from contextlib import contextmanager
from email.message import Message
from pathlib import Path

import pytest

from soc_check import Container, Image

pytestmark = pytest.mark.lane

SUPABASE = "http://192.168.1.40:8000"
TMPFS = ("--tmpfs", "/tmp:size=4m")
SETTINGS = {
    "telemetry_stale_after_ms": 3000,
    "telemetry_lost_after_ms": 10000,
    "geofence_warning_band_m": 5,
    "geofence_max_vertices": 32,
    "max_arc_spacing_m": 10,
}
IN_THE_CONTAINER = "/etc/soc/soc-web.json"
MEMORY_AT_REST_BYTES = 16 * 1024**2
SERVICE_KEY_REFUSED = "the service role key, which must never reach a browser (NFR-SEC-02)"
ORGANIZATION = "3f6c2a1e-8b7d-4e5f-9a0b-1c2d3e4f5a6b"
MISSING_ORGANIZATION = "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b"
# The three files of a baked site model (ADR-0018), each with the type it is served as.
# The JSON is over 1 KB, so nginx compresses it for a browser, as it would a real model.
SITE_JSON = json.dumps({"attribution": "IGN, CC BY 4.0. " * 100}).encode() + b"\n"
SITE_FILES = {
    "site.json": ("application/json", SITE_JSON),
    "elevation.f32": ("application/octet-stream", b"\x00\x00\x80\x3f" * 4),
    "imagery.png": ("image/png", b"\x89PNG\r\n\x1a\nfake"),
}


def jwt_for(role: str) -> str:
    def part(value: dict[str, str]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'HS256'})}.{part({'iss': 'supabase', 'role': role})}.signature"


@pytest.fixture(scope="module")
def settings_file(tmp_path_factory: pytest.TempPathFactory) -> Path:
    file = tmp_path_factory.mktemp("soc-web") / "soc-web.json"
    file.write_text(json.dumps(SETTINGS, indent=2) + "\n", encoding="utf-8")
    file.chmod(0o644)
    file.parent.chmod(0o755)
    return file


def mounted(file: Path) -> tuple[str, ...]:
    return ("-v", f"{file}:{IN_THE_CONTAINER}:ro")


def problems(image: Image, environment: dict[str, str], *options: str) -> list[str]:
    run = image.run(environment, *TMPFS, *options)
    assert run.status == 2
    (line,) = run.lines
    assert (line["event"], line["service"]) == ("configuration_refused", "soc-web")
    return list(line["problems"])


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class Served:
    def __init__(self, container: Container, port: int) -> None:
        self.container = container
        self.port = port

    def send(
        self, method: str, path: str, headers: dict[str, str] | None = None
    ) -> tuple[int, Message, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            answer = connection.getresponse()
            return answer.status, answer.headers, answer.read()
        finally:
            connection.close()

    def get(self, path: str) -> tuple[int, Message, bytes]:
        return self.send("GET", path)


def configured(**environment: str) -> dict[str, str]:
    return {
        "SOC_WEB_SUPABASE_URL": SUPABASE,
        "SOC_WEB_SUPABASE_KEY": jwt_for("anon"),
        "SOC_CONFIG_FILE": IN_THE_CONTAINER,
        **environment,
    }


@contextmanager
def serving(image: Image, *options: str, address: str = SUPABASE) -> Iterator[Served]:
    port = free_port()
    container = image.start(
        f"soc-check-web-{secrets.token_hex(3)}",
        configured(SOC_WEB_SUPABASE_URL=address),
        *TMPFS, "-p", f"127.0.0.1:{port}:8080", "--memory", "32m", *options,
        network="bridge",
    )  # fmt: skip
    try:
        container.wait_until_healthy()
        yield Served(container, port)
    finally:
        container.remove()


@pytest.fixture(scope="module")
def served(images: dict[str, Image], settings_file: Path) -> Iterator[Served]:
    with serving(images["soc-web"], *mounted(settings_file), address=f"{SUPABASE}/") as web:
        yield web


def site_mount(folder: Path) -> tuple[str, str]:
    return ("-v", f"{folder}:/srv/site:ro")


def readable(folder: Path) -> Path:
    # The console runs as user 10001, which reads the folder through its world bits.
    for path in (folder, *folder.rglob("*")):
        path.chmod(0o755 if path.is_dir() else 0o644)
    return folder


@pytest.fixture(scope="module")
def site_models(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("site")
    (root / ORGANIZATION).mkdir()
    for name, (_, body) in SITE_FILES.items():
        (root / ORGANIZATION / name).write_bytes(body)
    (root / ORGANIZATION / "notes.html").write_text("<!doctype html>\n", encoding="utf-8")
    return readable(root)


@pytest.fixture(scope="module")
def empty_site(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return readable(tmp_path_factory.mktemp("empty-site"))


@pytest.fixture(scope="module")
def modelled(images: dict[str, Image], settings_file: Path, site_models: Path) -> Iterator[Served]:
    with serving(images["soc-web"], *mounted(settings_file), *site_mount(site_models)) as web:
        yield web


def test_the_web_image_runs_as_an_unprivileged_user_and_group(images: dict[str, Image]) -> None:
    assert images["soc-web"].user() == "10001:10001"


def test_without_its_configuration_the_web_refuses_to_start(images: dict[str, Image]) -> None:
    assert problems(images["soc-web"], {}) == [
        "SOC_WEB_SUPABASE_URL is not set",
        "SOC_WEB_SUPABASE_KEY is not set",
        "SOC_CONFIG_FILE is not set",
    ]


def test_a_console_file_it_cannot_read_is_refused(images: dict[str, Image]) -> None:
    assert problems(images["soc-web"], configured()) == ["SOC_CONFIG_FILE cannot be read"]


@pytest.mark.parametrize("key", [jwt_for("service_role"), "sb_secret_" + "x" * 24])
def test_the_service_role_key_never_reaches_a_browser(
    images: dict[str, Image], settings_file: Path, key: str
) -> None:
    refused = problems(
        images["soc-web"], configured(SOC_WEB_SUPABASE_KEY=key), *mounted(settings_file)
    )
    assert refused == [f"SOC_WEB_SUPABASE_KEY is {SERVICE_KEY_REFUSED}"]
    assert key not in json.dumps(refused)


@pytest.mark.parametrize(
    "url", ["http://192.168.1.40:8000/rest/v1", "ftp://192.168.1.40", '"http://x"']
)
def test_an_address_with_a_path_or_another_scheme_is_refused(
    images: dict[str, Image], settings_file: Path, url: str
) -> None:
    environment = configured(SOC_WEB_SUPABASE_URL=url)
    assert problems(images["soc-web"], environment, *mounted(settings_file)) == [
        "SOC_WEB_SUPABASE_URL must be an http(s) URL with no path"
    ]


def test_the_configuration_is_written_at_start_and_never_cached(served: Served) -> None:
    status, headers, body = served.get("/config.json")
    assert status == 200
    assert json.loads(body) == {
        "supabase_url": SUPABASE,
        "supabase_key": jwt_for("anon"),
        "settings": SETTINGS,
    }
    assert headers["Cache-Control"] == "no-store"


def test_the_console_is_hardened_and_talks_only_to_its_supabase(served: Served) -> None:
    status, headers, body = served.get("/")
    assert status == 200
    assert b'<div id="root">' in body
    policy = dict(
        directive.strip().split(" ", 1)
        for directive in headers["Content-Security-Policy"].split(";")
    )
    assert policy["connect-src"] == f"'self' {SUPABASE} ws://192.168.1.40:8000"
    assert policy["script-src"] == "'self'"
    assert policy["style-src"] == "'self'"
    assert policy["frame-ancestors"] == "'none'"
    assert policy["object-src"] == "'none'"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Server"] == "nginx"
    assert headers["Cache-Control"] == "no-store"


def test_built_files_are_cached_for_good_and_routes_fall_back_to_the_console(
    served: Served,
) -> None:
    _, _, index = served.get("/")
    script = index.split(b'src="', 1)[1].split(b'"', 1)[0].decode()
    status, headers, _ = served.get(script)
    assert (status, headers["Cache-Control"]) == (200, "public, max-age=31536000, immutable")
    assert headers["Content-Security-Policy"].startswith("default-src 'self'")
    assert served.get("/fleet/anything")[2] == index


def test_the_web_is_healthy_and_small_at_rest(served: Served) -> None:
    assert served.container.health() == "healthy"
    assert served.get("/healthz")[0] == 200
    lines = [line["event"] for line in served.container.logs()]
    memory = served.container.memory_bytes()
    assert lines == ["service_started"]
    assert memory < MEMORY_AT_REST_BYTES, f"{memory / 1024**2:.1f} MiB at rest"


def test_one_image_serves_any_address(images: dict[str, Image], settings_file: Path) -> None:
    addresses = ("http://192.168.1.40:8000", "https://farm.example")
    containers = []
    try:
        for address in addresses:
            port = free_port()
            container = images["soc-web"].start(
                f"soc-check-web-{secrets.token_hex(3)}",
                configured(SOC_WEB_SUPABASE_URL=address),
                *TMPFS, *mounted(settings_file), "-p", f"127.0.0.1:{port}:8080",
                network="bridge",
            )  # fmt: skip
            containers.append(container)
            container.wait_until_healthy()
            body = Served(container, port).get("/config.json")[2]
            assert json.loads(body)["supabase_url"] == address
            assert address in Served(container, port).get("/")[1]["Content-Security-Policy"]
    finally:
        for container in containers:
            container.remove()


@pytest.mark.parametrize("name", list(SITE_FILES))
def test_a_mounted_site_model_file_is_served_with_its_type_and_no_cache(
    modelled: Served, name: str
) -> None:
    content_type, body = SITE_FILES[name]
    status, headers, served_body = modelled.get(f"/site/{ORGANIZATION}/{name}")
    assert status == 200
    assert headers["Content-Type"] == content_type
    assert headers["Cache-Control"] == "no-cache"
    assert headers["ETag"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Content-Security-Policy"].startswith("default-src 'self'")
    assert served_body == body


def test_a_browser_gets_a_site_model_compressed_and_revalidates_it(modelled: Served) -> None:
    path = f"/site/{ORGANIZATION}/site.json"
    status, headers, body = modelled.send("GET", path, {"Accept-Encoding": "gzip"})
    assert status == 200
    assert (headers["Content-Encoding"], headers["Vary"]) == ("gzip", "Accept-Encoding")
    assert gzip.decompress(body) == SITE_FILES["site.json"][1]
    status, _, _ = modelled.send(
        "GET", path, {"Accept-Encoding": "gzip", "If-None-Match": headers["ETag"]}
    )
    assert status == 304


def test_a_file_that_is_not_a_model_file_is_served_as_data_not_as_a_page(
    modelled: Served,
) -> None:
    status, headers, _ = modelled.get(f"/site/{ORGANIZATION}/notes.html")
    assert status == 200
    assert headers["Content-Type"] == "application/octet-stream"


def test_head_answers_a_site_model_with_its_headers_and_no_body(modelled: Served) -> None:
    status, headers, body = modelled.send("HEAD", f"/site/{ORGANIZATION}/site.json")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert headers["Content-Length"] == str(len(SITE_FILES["site.json"][1]))
    assert body == b""


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE"])
def test_only_get_and_head_reach_a_site_model(modelled: Served, method: str) -> None:
    status, headers, _ = modelled.send(method, f"/site/{ORGANIZATION}/site.json")
    assert status == 405
    assert headers["Allow"] == "GET, HEAD"
    assert headers["Content-Security-Policy"].startswith("default-src 'self'")


@pytest.mark.parametrize(
    "path",
    [
        f"/site/{MISSING_ORGANIZATION}/site.json",
        f"/site/{ORGANIZATION}/missing.f32",
        f"/site/{ORGANIZATION}/site.json/",
        "/site",
    ],
)
def test_a_missing_site_model_is_not_found_and_never_the_console(
    modelled: Served, path: str
) -> None:
    status, headers, body = modelled.get(path)
    assert status == 404
    assert b'<div id="root">' not in body
    assert headers["Cache-Control"] == "no-cache"


@pytest.mark.parametrize("path", ["/site/", f"/site/{ORGANIZATION}/", f"/site/{ORGANIZATION}"])
def test_a_site_folder_is_not_listed(modelled: Served, path: str) -> None:
    status, _, body = modelled.get(path)
    assert status == 404
    assert b"Index of" not in body
    assert b'<div id="root">' not in body


def test_without_a_site_mount_no_model_is_found_and_the_console_serves(served: Served) -> None:
    assert served.get("/")[0] == 200
    status, _, body = served.get(f"/site/{ORGANIZATION}/site.json")
    assert status == 404
    assert b'<div id="root">' not in body


def test_an_empty_site_folder_is_served_like_no_folder(
    images: dict[str, Image], settings_file: Path, empty_site: Path
) -> None:
    with serving(images["soc-web"], *mounted(settings_file), *site_mount(empty_site)) as web:
        assert web.get("/")[0] == 200
        status, _, body = web.get(f"/site/{ORGANIZATION}/site.json")
        assert status == 404
        assert b'<div id="root">' not in body
