"""The wayline API client against a fake so-wayline on loopback (FR-LNK-08, FR-LNK-09).

The shapes are held to the vendored contract (contracts/sky-orchestrator/wayline/openapi.yaml)
through CONTRACT and ENUMS below. soc-cloud reads no YAML, so those tables were read from the
file and written here; a change to the file fails these tests until the tables follow it.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from http import HTTPStatus
from typing import Any

import aiohttp
import msgspec
import pytest
from aiohttp import web

import soc_config
from soc_cloud.so_api import (
    BODY_LIMIT_BYTES,
    BridgeLink,
    BridgeLinkState,
    Check,
    CheckStatus,
    Envelope,
    EnvelopeLimits,
    GeofenceCenter,
    Problem,
    ProblemKind,
    RejectionCode,
    Report,
    SoApi,
    SoApiError,
    StackStatus,
    Validation,
    Verdict,
)

TOKEN = "wayline-" + "7" * 32
SHA_CONFIG = hashlib.sha256(b"the phone's configuration").hexdigest()
SHA_ENVELOPE = hashlib.sha256(b"the envelope's values").hexdigest()
MD5 = hashlib.md5(b"the reference wayline", usedforsecurity=False).hexdigest()
# Every byte value, and the zip signature: the body must arrive exactly as it was sent.
KMZ = b"PK\x03\x04" + bytes(range(256)) * 4

STATUS: dict[str, Any] = {
    "schema_version": "1.3.0",
    "at_ms": 1791000000000,
    "simulator_mode": True,
    "link": {"state": "up", "reason": "connected", "changed_at_ms": 1790999900000},
    "simulator_active": True,
    "aircraft_connected": True,
    "aircraft_online": True,
    "aircraft_reason": "link up, aircraft connected, telemetry fresh",
    "armed": True,
    "arming_remaining_s": 42,
    "clock_offset_ms": -180,
    "clock_offset_uncertainty_ms": 25,
    "contract_version": "2.1.0",
    "config_fingerprint": SHA_CONFIG,
    "warnings": [{"code": "clock_offset_beyond_limit", "message": "clock 180 ms behind"}],
}

ENVELOPE: dict[str, Any] = {
    "envelope": {
        "geofence_center": {"latitude_deg": 45.0, "longitude_deg": 7.0},
        "geofence_radius_m": 3000.0,
        "max_height_m": 120.0,
        "max_home_distance_m": 2500.0,
        "max_leg_m": 1500.0,
        "max_transit_m": 2000.0,
        "max_total_distance_m": 20000.0,
        "max_waypoints": 200,
        "max_horizontal_speed_ms": 15.0,
    },
    "envelope_fingerprint": SHA_ENVELOPE,
    "config_fingerprint": SHA_CONFIG,
    "application_in_force": None,
}

VALIDATION: dict[str, Any] = {
    "status": "REJECTED",
    "fingerprint_md5": MD5,
    "size_bytes": 48213,
    "config_fingerprint": SHA_CONFIG,
    "metadata": {
        "name": "reference",
        "template_type": "waypoints",
        "height_mode": "relativeToStartPoint",
        "takeoff_ref_point": "45.0,7.0,0",
        "takeoff_security_height_m": 20.0,
        "waypoint_count": 12,
        "total_distance_m": 5400.0,
        "config_fingerprint": SHA_CONFIG,
    },
    "report": {
        "status": "REJECTED",
        "checks": [
            {"check": "archive", "status": "passed", "detail": "a zip with 4 entries"},
            {"check": "geofence", "status": "failed", "detail": "1 waypoint outside"},
            {"check": "transit", "status": "deferred", "detail": "no takeoff given"},
        ],
        "problems": [
            {
                "code": "outside_geofence",
                "kind": "envelope",
                "message": "waypoint 3 is 3412 m from the centre, the limit is 3000 m",
                "file": "wpmz/template.kml",
                "path": "Document/Folder/Placemark[4]/Point/coordinates",
                "line": 118,
                "waypoint_index": 3,
                "details": {"distance_m": 3412.0, "limit_m": 3000.0},
            },
            {
                "code": "speed_above_max",
                "kind": "envelope",
                "message": "waypoint 5 flies at 18 m/s, the limit is 15 m/s",
                "waypoint_index": 5,
            },
        ],
    },
}

BODIES: dict[str, dict[str, Any]] = {
    "status": STATUS,
    "envelope": ENVELOPE,
    "validate": VALIDATION,
}
CALLS: dict[str, Callable[[SoApi], Awaitable[object]]] = {
    "status": lambda api: api.status(),
    "envelope": lambda api: api.envelope(),
    "validate": lambda api: api.validate(KMZ, takeoff=None),
}

# Every field of StackStatus the contract marks nullable: SO sends null for one the stack does
# not know. The contract's `required` lists them too, yet a missing one reads as unknown, the
# same as a null (FR-LNK-08): it is never a default that could pass for a measurement.
STATUS_UNKNOWN_PATHS: list[tuple[str, ...]] = [
    ("simulator_mode",),
    ("simulator_active",),
    ("aircraft_connected",),
    ("aircraft_online",),
    ("aircraft_reason",),
    ("armed",),
    ("arming_remaining_s",),
    ("clock_offset_ms",),
    ("clock_offset_uncertainty_ms",),
    ("contract_version",),
    ("config_fingerprint",),
    ("warnings",),
    ("link", "state"),
    ("link", "reason"),
    ("link", "changed_at_ms"),
]

PROBLEM_OPTIONAL_FIELDS = ["file", "path", "line", "waypoint_index", "details"]

# The contract's properties of each schema, and those a response may leave out or null (they
# are None by default here). Every other property is required and has no default.
CONTRACT: dict[type[msgspec.Struct], tuple[frozenset[str], frozenset[str]]] = {
    StackStatus: (
        frozenset(
            {
                "schema_version",
                "at_ms",
                "simulator_mode",
                "link",
                "simulator_active",
                "aircraft_connected",
                "aircraft_online",
                "aircraft_reason",
                "armed",
                "arming_remaining_s",
                "clock_offset_ms",
                "clock_offset_uncertainty_ms",
                "contract_version",
                "config_fingerprint",
                "warnings",
            }
        ),
        frozenset(
            {
                "simulator_mode",
                "simulator_active",
                "aircraft_connected",
                "aircraft_online",
                "aircraft_reason",
                "armed",
                "arming_remaining_s",
                "clock_offset_ms",
                "clock_offset_uncertainty_ms",
                "contract_version",
                "config_fingerprint",
                "warnings",
            }
        ),
    ),
    BridgeLink: (
        frozenset({"state", "reason", "changed_at_ms"}),
        frozenset({"state", "reason", "changed_at_ms"}),
    ),
    Envelope: (
        frozenset(
            {"envelope", "envelope_fingerprint", "config_fingerprint", "application_in_force"}
        ),
        frozenset({"application_in_force"}),
    ),
    EnvelopeLimits: (
        frozenset(
            {
                "geofence_center",
                "geofence_radius_m",
                "max_height_m",
                "max_home_distance_m",
                "max_leg_m",
                "max_transit_m",
                "max_total_distance_m",
                "max_waypoints",
                "max_horizontal_speed_ms",
            }
        ),
        frozenset(),
    ),
    GeofenceCenter: (frozenset({"latitude_deg", "longitude_deg"}), frozenset()),
    Validation: (
        frozenset(
            {
                "status",
                "fingerprint_md5",
                "size_bytes",
                "config_fingerprint",
                "metadata",
                "report",
            }
        ),
        frozenset(),
    ),
    Report: (frozenset({"status", "checks", "problems"}), frozenset()),
    Check: (frozenset({"check", "status", "detail"}), frozenset()),
    Problem: (
        frozenset({"code", "kind", "message", "file", "path", "line", "waypoint_index", "details"}),
        frozenset(PROBLEM_OPTIONAL_FIELDS),
    ),
}

# The closed enumerations, in the contract's order.
ENUMS: dict[type[StrEnum], list[str]] = {
    Verdict: ["VALID", "REJECTED"],
    BridgeLinkState: ["up", "down"],
    CheckStatus: ["passed", "failed", "deferred"],
    ProblemKind: ["container", "malformed", "unsupported", "missing", "envelope"],
    RejectionCode: [
        "kmz_too_large",
        "not_a_zip",
        "path_traversal",
        "unexpected_entry",
        "duplicate_entry",
        "too_many_entries",
        "encrypted_entry",
        "unsupported_compression",
        "archive_expands_too_far",
        "corrupt_entry",
        "template_missing",
        "waylines_missing",
        "xml_malformed",
        "xml_doctype",
        "namespace_unsupported",
        "element_unsupported",
        "value_unsupported",
        "value_malformed",
        "element_missing",
        "element_repeated",
        "template_type_unsupported",
        "height_mode_wgs84",
        "height_mode_follow_surface",
        "too_many_waypoints",
        "takeoff_security_height_above_max",
        "height_above_max",
        "outside_geofence",
        "leg_too_long",
        "total_distance_too_long",
        "speed_above_max",
        "transit_too_long",
        "home_distance_too_far",
    ],
}


@dataclass
class Received:
    method: str
    path: str
    query: dict[str, str]
    authorization: str | None
    content_type: str | None
    body: bytes


@dataclass
class FakeWayline:
    """so-wayline's HTTP API, answering what a test sets and recording every request."""

    base_url: str = ""
    requests: list[Received] = field(default_factory=list)
    status: int = HTTPStatus.OK
    body: bytes = b""
    location: str | None = None
    hang: bool = False
    drop: bool = False
    release: asyncio.Event = field(default_factory=asyncio.Event)

    def application(self) -> web.Application:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._answer)
        return app

    def answer(
        self, body: object, status: int = HTTPStatus.OK, location: str | None = None
    ) -> None:
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.status = status
        self.location = location

    def reset(self) -> None:
        self.requests.clear()
        self.answer(b"")
        self.hang = False
        self.drop = False
        previous, self.release = self.release, asyncio.Event()
        # A handler a test left hanging is released here, not left to block the shutdown.
        previous.set()

    async def _answer(self, request: web.Request) -> web.StreamResponse:
        self.requests.append(
            Received(
                method=request.method,
                path=request.path,
                query=dict(request.query),
                authorization=request.headers.get("Authorization"),
                content_type=request.headers.get("Content-Type"),
                body=await request.read(),
            )
        )
        if self.hang:
            await self.release.wait()
        if self.drop:
            assert request.transport is not None
            request.transport.close()
            return web.Response()
        headers = {} if self.location is None else {"Location": self.location}
        return web.Response(status=self.status, body=self.body, headers=headers)


@pytest.fixture(scope="session")
async def server() -> AsyncIterator[FakeWayline]:
    fake = FakeWayline()
    runner = web.AppRunner(fake.application())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.base_url = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        yield fake
    finally:
        fake.release.set()
        await runner.cleanup()


@pytest.fixture
def wayline(server: FakeWayline) -> FakeWayline:
    server.reset()
    return server


@pytest.fixture
async def session() -> AsyncIterator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession() as client:
        yield client


@pytest.fixture
def api(session: aiohttp.ClientSession, wayline: FakeWayline) -> SoApi:
    return SoApi(session, wayline.base_url, soc_config.Secret(TOKEN), timeout_s=5.0)


def without_or_null(body: dict[str, Any], path: tuple[str | int, ...], mode: str) -> dict[str, Any]:
    """A copy of body with the value at path left out, or set to null."""
    edited = copy.deepcopy(body)
    parent: Any = edited
    for key in path[:-1]:
        parent = parent[key]
    if mode == "absent":
        del parent[path[-1]]
    else:
        parent[path[-1]] = None
    return edited


def dig(value: Any, path: tuple[str | int, ...]) -> Any:
    for key in path:
        value = value[key] if isinstance(key, int) else getattr(value, key)
    return value


def dotted(path: tuple[str | int, ...]) -> str:
    return ".".join(str(key) for key in path)


EXPECTED_STATUS = StackStatus(
    schema_version="1.3.0",
    at_ms=1791000000000,
    simulator_mode=True,
    link=BridgeLink(state=BridgeLinkState.UP, reason="connected", changed_at_ms=1790999900000),
    simulator_active=True,
    aircraft_connected=True,
    aircraft_online=True,
    aircraft_reason="link up, aircraft connected, telemetry fresh",
    armed=True,
    arming_remaining_s=42,
    clock_offset_ms=-180,
    clock_offset_uncertainty_ms=25,
    contract_version="2.1.0",
    config_fingerprint=SHA_CONFIG,
    warnings=({"code": "clock_offset_beyond_limit", "message": "clock 180 ms behind"},),
)


async def test_status_decodes_every_field_of_the_example(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer(STATUS)
    status = await api.status()
    assert status == EXPECTED_STATUS
    assert status.link.state is BridgeLinkState.UP
    assert status.arming_remaining_s == 42


async def test_a_null_simulator_mode_is_unknown_not_false(wayline: FakeWayline, api: SoApi) -> None:
    # FR-LNK-08's acceptance, the part this client holds: the mode reads as unknown, not false.
    wayline.answer(without_or_null(STATUS, ("simulator_mode",), "null"))
    assert (await api.status()).simulator_mode is None


@pytest.mark.parametrize("mode", ["absent", "null"])
@pytest.mark.parametrize("path", STATUS_UNKNOWN_PATHS, ids=dotted)
async def test_a_status_field_the_stack_does_not_know_is_none(
    wayline: FakeWayline, api: SoApi, path: tuple[str, ...], mode: str
) -> None:
    wayline.answer(without_or_null(STATUS, path, mode))
    assert dig(await api.status(), path) is None


async def test_the_envelope_example_decodes_to_every_limit(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(ENVELOPE)
    assert await api.envelope() == Envelope(
        envelope=EnvelopeLimits(
            geofence_center=GeofenceCenter(latitude_deg=45.0, longitude_deg=7.0),
            geofence_radius_m=3000.0,
            max_height_m=120.0,
            max_home_distance_m=2500.0,
            max_leg_m=1500.0,
            max_transit_m=2000.0,
            max_total_distance_m=20000.0,
            max_waypoints=200,
            max_horizontal_speed_ms=15.0,
        ),
        envelope_fingerprint=SHA_ENVELOPE,
        config_fingerprint=SHA_CONFIG,
        application_in_force=None,
    )


@pytest.mark.parametrize("mode", ["absent", "null"])
async def test_application_in_force_is_none_when_absent_or_null(
    wayline: FakeWayline, api: SoApi, mode: str
) -> None:
    wayline.answer(without_or_null(ENVELOPE, ("application_in_force",), mode))
    assert (await api.envelope()).application_in_force is None


async def test_a_refused_file_keeps_every_check_and_problem_in_the_order_so_named(
    wayline: FakeWayline, api: SoApi
) -> None:
    # FR-LNK-09's acceptance, the part this client holds: every problem SO named, with its index.
    wayline.answer(VALIDATION)
    validation = await api.validate(KMZ, takeoff=None)
    assert validation == Validation(
        status=Verdict.REJECTED,
        fingerprint_md5=MD5,
        size_bytes=48213,
        config_fingerprint=SHA_CONFIG,
        metadata=VALIDATION["metadata"],
        report=Report(
            status=Verdict.REJECTED,
            checks=(
                Check(check="archive", status=CheckStatus.PASSED, detail="a zip with 4 entries"),
                Check(check="geofence", status=CheckStatus.FAILED, detail="1 waypoint outside"),
                Check(check="transit", status=CheckStatus.DEFERRED, detail="no takeoff given"),
            ),
            problems=(
                Problem(
                    code=RejectionCode.OUTSIDE_GEOFENCE,
                    kind=ProblemKind.ENVELOPE,
                    message="waypoint 3 is 3412 m from the centre, the limit is 3000 m",
                    file="wpmz/template.kml",
                    path="Document/Folder/Placemark[4]/Point/coordinates",
                    line=118,
                    waypoint_index=3,
                    details={"distance_m": 3412.0, "limit_m": 3000.0},
                ),
                Problem(
                    code=RejectionCode.SPEED_ABOVE_MAX,
                    kind=ProblemKind.ENVELOPE,
                    message="waypoint 5 flies at 18 m/s, the limit is 15 m/s",
                    waypoint_index=5,
                ),
            ),
        ),
    )


@pytest.mark.parametrize("mode", ["absent", "null"])
@pytest.mark.parametrize("name", PROBLEM_OPTIONAL_FIELDS)
async def test_an_optional_problem_field_is_none_when_absent_or_null(
    wayline: FakeWayline, api: SoApi, name: str, mode: str
) -> None:
    problem = without_or_null(VALIDATION["report"]["problems"][0], (name,), mode)
    report = {**VALIDATION["report"], "problems": [problem]}
    wayline.answer({**VALIDATION, "report": report})
    (decoded,) = (await api.validate(KMZ, takeoff=None)).report.problems
    assert getattr(decoded, name) is None


async def test_fields_a_newer_so_adds_are_ignored(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer({**STATUS, "future_field": {"anything": [1, 2]}})
    assert (await api.status()).schema_version == "1.3.0"


@pytest.mark.parametrize(
    ("struct", "shape"), list(CONTRACT.items()), ids=[cls.__name__ for cls in CONTRACT]
)
def test_a_struct_holds_the_contracts_properties_and_defaults(
    struct: type[msgspec.Struct], shape: tuple[frozenset[str], frozenset[str]]
) -> None:
    properties, nullable = shape
    fields = msgspec.structs.fields(struct)
    assert {info.encode_name for info in fields} == properties, struct.__name__
    assert {info.name for info in fields} == properties, struct.__name__
    for info in fields:
        assert info.default_factory is msgspec.NODEFAULT, info.name
        if info.name in nullable:
            assert info.default is None, info.name
        else:
            assert info.default is msgspec.NODEFAULT, info.name


@pytest.mark.parametrize(
    ("enum_type", "values"), list(ENUMS.items()), ids=[cls.__name__ for cls in ENUMS]
)
def test_an_enum_holds_the_contracts_closed_values(
    enum_type: type[StrEnum], values: list[str]
) -> None:
    assert [member.value for member in enum_type] == values


async def test_every_call_sends_the_bearer_token_to_its_path(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(STATUS)
    await api.status()
    wayline.answer(ENVELOPE)
    await api.envelope()
    wayline.answer(VALIDATION)
    await api.validate(KMZ, takeoff=None)
    assert [(r.method, r.path, r.authorization) for r in wayline.requests] == [
        ("GET", "/v1/status", f"Bearer {TOKEN}"),
        ("GET", "/v1/envelope", f"Bearer {TOKEN}"),
        ("POST", "/v1/validations", f"Bearer {TOKEN}"),
    ]


async def test_the_kmz_arrives_byte_for_byte_as_a_kmz(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer(VALIDATION)
    await api.validate(KMZ, takeoff=None)
    (received,) = wayline.requests
    assert received.body == KMZ
    assert received.content_type == "application/vnd.google-earth.kmz"


async def test_the_takeoff_is_sent_as_the_query_the_contract_names(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(VALIDATION)
    await api.validate(KMZ, takeoff=(41.6523, -4.7245))
    (received,) = wayline.requests
    assert received.query == {
        "takeoff_latitude_deg": "41.6523",
        "takeoff_longitude_deg": "-4.7245",
    }


async def test_no_takeoff_sends_no_query(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer(VALIDATION)
    await api.validate(KMZ, takeoff=None)
    (received,) = wayline.requests
    assert received.query == {}


async def test_the_takeoff_bounds_are_inclusive(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer(VALIDATION)
    await api.validate(KMZ, takeoff=(-90.0, 180.0))
    await api.validate(KMZ, takeoff=(90.0, -180.0))
    assert [r.query for r in wayline.requests] == [
        {"takeoff_latitude_deg": "-90.0", "takeoff_longitude_deg": "180.0"},
        {"takeoff_latitude_deg": "90.0", "takeoff_longitude_deg": "-180.0"},
    ]


@pytest.mark.parametrize(
    "takeoff",
    [(90.5, 0.0), (-91.0, 0.0), (0.0, 180.5), (0.0, -181.0), (math.nan, 0.0), (0.0, math.inf)],
)
async def test_a_takeoff_outside_the_bounds_is_refused_before_anything_is_sent(
    wayline: FakeWayline, api: SoApi, takeoff: tuple[float, float]
) -> None:
    with pytest.raises(ValueError, match="takeoff"):
        await api.validate(KMZ, takeoff=takeoff)
    assert wayline.requests == []


async def test_a_trailing_slash_on_the_base_url_is_not_doubled(
    session: aiohttp.ClientSession, wayline: FakeWayline
) -> None:
    api = SoApi(session, wayline.base_url + "/", soc_config.Secret(TOKEN), timeout_s=5.0)
    wayline.answer(STATUS)
    await api.status()
    assert wayline.requests[0].path == "/v1/status"


@pytest.mark.parametrize("timeout_s", [0.0, -1.0, math.nan])
async def test_a_timeout_must_be_positive(session: aiohttp.ClientSession, timeout_s: float) -> None:
    with pytest.raises(ValueError, match="timeout_s"):
        SoApi(session, "http://127.0.0.1:1", soc_config.Secret(TOKEN), timeout_s=timeout_s)


async def test_an_unauthorized_call_raises_with_its_status_and_body(
    wayline: FakeWayline, api: SoApi
) -> None:
    body = {"code": "unauthorized", "message": "the bearer token is missing or wrong"}
    wayline.answer(body, status=HTTPStatus.UNAUTHORIZED)
    with pytest.raises(SoApiError, match="401") as raised:
        await api.status()
    assert raised.value.status == 401
    assert raised.value.body is not None
    assert json.loads(raised.value.body) == body


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (HTTPStatus.INTERNAL_SERVER_ERROR, b"internal error"),
        (HTTPStatus.SERVICE_UNAVAILABLE, b""),
        (HTTPStatus.NO_CONTENT, b""),
    ],
)
async def test_a_status_other_than_200_raises_with_that_status(
    wayline: FakeWayline, api: SoApi, status: int, body: bytes
) -> None:
    wayline.answer(body, status=status)
    with pytest.raises(SoApiError) as raised:
        await api.envelope()
    assert raised.value.status == status
    assert raised.value.body == (body.decode() or None)


async def test_a_refused_file_raises_with_the_rejection_and_its_limit(
    wayline: FakeWayline, api: SoApi
) -> None:
    body = {
        "code": "kmz_too_large",
        "message": "the file is larger than the limit",
        "details": {"limit_bytes": 1000},
    }
    wayline.answer(body, status=HTTPStatus.UNPROCESSABLE_ENTITY)
    with pytest.raises(SoApiError) as raised:
        await api.validate(KMZ, takeoff=None)
    assert raised.value.status == 422
    assert raised.value.body is not None
    assert json.loads(raised.value.body) == body


async def test_a_redirect_is_refused_not_followed_so_the_token_stays_at_the_configured_address(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(b"", status=HTTPStatus.FOUND, location="/v1/elsewhere")
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.status == HTTPStatus.FOUND
    assert [request.path for request in wayline.requests] == ["/v1/status"]


async def test_a_refusal_body_is_kept_only_to_the_limit(wayline: FakeWayline, api: SoApi) -> None:
    wayline.answer(b"x" * (BODY_LIMIT_BYTES * 4), status=HTTPStatus.INTERNAL_SERVER_ERROR)
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.body is not None
    assert set(raised.value.body) == {"x"}
    assert len(raised.value.body) <= BODY_LIMIT_BYTES


async def test_a_timeout_raises_without_a_status(
    wayline: FakeWayline, session: aiohttp.ClientSession
) -> None:
    wayline.hang = True
    api = SoApi(session, wayline.base_url, soc_config.Secret(TOKEN), timeout_s=0.05)
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.status is None
    assert raised.value.body is None
    assert isinstance(raised.value.__cause__, TimeoutError)


async def test_a_dropped_connection_raises_without_a_status(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.drop = True
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.status is None
    assert isinstance(raised.value.__cause__, aiohttp.ClientError)


async def test_an_unreachable_stack_raises_without_a_status(
    session: aiohttp.ClientSession,
) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    api = SoApi(session, f"http://127.0.0.1:{port}", soc_config.Secret(TOKEN), timeout_s=5.0)
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.status is None
    assert isinstance(raised.value.__cause__, aiohttp.ClientError)


BROKEN: list[Any] = [
    pytest.param(
        "status",
        lambda body: body.pop("at_ms"),
        id="status-missing-required-at_ms",
    ),
    pytest.param(
        "status",
        lambda body: body.update(at_ms="1791000000000"),
        id="status-at_ms-a-string",
    ),
    pytest.param("status", lambda body: body.update(link=None), id="status-link-null"),
    pytest.param(
        "status",
        lambda body: body.update(schema_version="2.0.0"),
        id="status-schema_version-outside-1.x",
    ),
    pytest.param(
        "status",
        lambda body: body.update(config_fingerprint=SHA_CONFIG + "\n"),
        id="status-fingerprint-with-trailing-newline",
    ),
    pytest.param(
        "status",
        lambda body: body.update(arming_remaining_s=0),
        id="status-arming_remaining_s-below-1",
    ),
    pytest.param(
        "status",
        lambda body: body["link"].update(state="sideways"),
        id="status-link-state-outside-enum",
    ),
    pytest.param(
        "status", lambda body: body.update(warnings="none"), id="status-warnings-a-string"
    ),
    pytest.param(
        "envelope",
        lambda body: body["envelope"]["geofence_center"].update(latitude_deg=91.0),
        id="envelope-latitude-above-90",
    ),
    pytest.param(
        "envelope",
        lambda body: body["envelope"].update(max_waypoints=0),
        id="envelope-max_waypoints-below-1",
    ),
    pytest.param(
        "envelope",
        lambda body: body["envelope"].update(geofence_radius_m=0.0),
        id="envelope-radius-not-positive",
    ),
    pytest.param(
        "envelope",
        lambda body: body.pop("envelope_fingerprint"),
        id="envelope-missing-fingerprint",
    ),
    pytest.param(
        "envelope",
        lambda body: body.update(application_in_force="yes"),
        id="envelope-application_in_force-a-string",
    ),
    pytest.param(
        "validate",
        lambda body: body.update(status="PENDING"),
        id="validate-status-outside-enum",
    ),
    pytest.param(
        "validate",
        lambda body: body.update(fingerprint_md5="A" * 32),
        id="validate-md5-not-lower-hex",
    ),
    pytest.param(
        "validate",
        lambda body: body["report"].pop("checks"),
        id="validate-report-missing-checks",
    ),
    pytest.param(
        "validate",
        lambda body: body["report"]["problems"][0].update(code="gremlins"),
        id="validate-problem-code-outside-the-closed-list",
    ),
    pytest.param(
        "validate",
        lambda body: body["report"]["problems"][0].update(waypoint_index=-1),
        id="validate-waypoint_index-negative",
    ),
]


@pytest.mark.parametrize(("call", "edit"), BROKEN)
async def test_a_body_its_schema_refuses_raises_an_so_api_error(
    wayline: FakeWayline, api: SoApi, call: str, edit: Callable[[dict[str, Any]], object]
) -> None:
    body = copy.deepcopy(BODIES[call])
    edit(body)
    wayline.answer(body)
    with pytest.raises(SoApiError) as raised:
        await CALLS[call](api)
    assert raised.value.status == HTTPStatus.OK
    assert raised.value.body is not None
    assert "schema" in str(raised.value)


async def test_a_body_that_is_not_json_raises_an_so_api_error(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(b"<html>502 Bad Gateway</html>")
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert raised.value.status == HTTPStatus.OK
    assert raised.value.body == "<html>502 Bad Gateway</html>"


async def test_the_token_is_shown_neither_by_the_client_nor_by_its_errors(
    wayline: FakeWayline, api: SoApi
) -> None:
    wayline.answer(b"unauthorized", status=HTTPStatus.UNAUTHORIZED)
    with pytest.raises(SoApiError) as raised:
        await api.status()
    assert TOKEN not in repr(api)
    assert TOKEN not in str(raised.value)
    assert TOKEN not in repr(raised.value)
