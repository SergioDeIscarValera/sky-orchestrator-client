"""Sky Orchestrator's wayline HTTP API as a typed client (FR-LNK-08, FR-LNK-09).

so-wayline serves the stack's state (`GET /v1/status`), the envelope a wayline is
judged against (`GET /v1/envelope`) and a judgement of a flight file that keeps
nothing (`POST /v1/validations`). The shapes here mirror its vendored OpenAPI
contract (contracts/sky-orchestrator/wayline/openapi.yaml) field for field, under
the wire names. A field the contract marks nullable, or does not require, is None
when it is absent or null; no other field has a default. An unknown value stays
unknown (FR-LNK-08), and nothing stands in for a measurement (FR-SAF-03).

A call returns the whole answer or raises SoApiError: a status other than 200, a
transport failure, a timeout and a body its schema refuses are all refused alike.
Responses ignore fields SO adds in a minor version; the required ones stay required.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from http import HTTPStatus
from typing import Annotated

import aiohttp
import msgspec

import soc_config
from soc_supervision import describe

STATUS_PATH = "/v1/status"
ENVELOPE_PATH = "/v1/envelope"
VALIDATIONS_PATH = "/v1/validations"
KMZ_CONTENT_TYPE = "application/vnd.google-earth.kmz"
# What SO said when it refused, kept to this many bytes: an error body is a few hundred,
# and a proxy's page or a runaway body must not be read whole into memory.
BODY_LIMIT_BYTES = 4096

# JSON Schema's `$` matches only at the very end of a string, Python's `$` also before a
# final newline; the contract's patterns therefore end in `\Z` here.
MD5 = Annotated[str, msgspec.Meta(pattern=r"^[0-9a-f]{32}\Z")]
SHA256 = Annotated[str, msgspec.Meta(pattern=r"^[0-9a-f]{64}\Z")]
NonEmpty = Annotated[str, msgspec.Meta(min_length=1)]
NonNegative = Annotated[int, msgspec.Meta(ge=0)]
AtLeastOne = Annotated[int, msgspec.Meta(ge=1)]
Positive = Annotated[float, msgspec.Meta(gt=0)]
Latitude = Annotated[float, msgspec.Meta(ge=-90, le=90)]
Longitude = Annotated[float, msgspec.Meta(ge=-180, le=180)]


class Verdict(StrEnum):
    VALID = "VALID"
    REJECTED = "REJECTED"


class BridgeLinkState(StrEnum):
    UP = "up"
    DOWN = "down"


class CheckStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    DEFERRED = "deferred"


class ProblemKind(StrEnum):
    CONTAINER = "container"
    MALFORMED = "malformed"
    UNSUPPORTED = "unsupported"
    MISSING = "missing"
    ENVELOPE = "envelope"


class RejectionCode(StrEnum):
    """Why a file was refused. Closed in the contract: a new code is a contract change."""

    KMZ_TOO_LARGE = "kmz_too_large"
    NOT_A_ZIP = "not_a_zip"
    PATH_TRAVERSAL = "path_traversal"
    UNEXPECTED_ENTRY = "unexpected_entry"
    DUPLICATE_ENTRY = "duplicate_entry"
    TOO_MANY_ENTRIES = "too_many_entries"
    ENCRYPTED_ENTRY = "encrypted_entry"
    UNSUPPORTED_COMPRESSION = "unsupported_compression"
    ARCHIVE_EXPANDS_TOO_FAR = "archive_expands_too_far"
    CORRUPT_ENTRY = "corrupt_entry"
    TEMPLATE_MISSING = "template_missing"
    WAYLINES_MISSING = "waylines_missing"
    XML_MALFORMED = "xml_malformed"
    XML_DOCTYPE = "xml_doctype"
    NAMESPACE_UNSUPPORTED = "namespace_unsupported"
    ELEMENT_UNSUPPORTED = "element_unsupported"
    VALUE_UNSUPPORTED = "value_unsupported"
    VALUE_MALFORMED = "value_malformed"
    ELEMENT_MISSING = "element_missing"
    ELEMENT_REPEATED = "element_repeated"
    TEMPLATE_TYPE_UNSUPPORTED = "template_type_unsupported"
    HEIGHT_MODE_WGS84 = "height_mode_wgs84"
    HEIGHT_MODE_FOLLOW_SURFACE = "height_mode_follow_surface"
    TOO_MANY_WAYPOINTS = "too_many_waypoints"
    TAKEOFF_SECURITY_HEIGHT_ABOVE_MAX = "takeoff_security_height_above_max"
    HEIGHT_ABOVE_MAX = "height_above_max"
    OUTSIDE_GEOFENCE = "outside_geofence"
    LEG_TOO_LONG = "leg_too_long"
    TOTAL_DISTANCE_TOO_LONG = "total_distance_too_long"
    SPEED_ABOVE_MAX = "speed_above_max"
    TRANSIT_TOO_LONG = "transit_too_long"
    HOME_DISTANCE_TOO_FAR = "home_distance_too_far"


class BridgeLink(msgspec.Struct, kw_only=True, frozen=True, forbid_unknown_fields=False):
    """so-bridge's link state, with its reason and when it last changed (FR-DEV-07)."""

    state: BridgeLinkState | None = None
    reason: str | None = None
    changed_at_ms: NonNegative | None = None


class StackStatus(msgspec.Struct, kw_only=True, frozen=True, forbid_unknown_fields=False):
    """What DJI's wire does not carry (FR-DEV-07). A None is a value the stack did not know."""

    schema_version: Annotated[str, msgspec.Meta(pattern=r"^1\.[0-9]+\.[0-9]+\Z")]
    at_ms: NonNegative
    simulator_mode: bool | None = None
    link: BridgeLink
    simulator_active: bool | None = None
    aircraft_connected: bool | None = None
    aircraft_online: bool | None = None
    aircraft_reason: str | None = None
    armed: bool | None = None
    arming_remaining_s: AtLeastOne | None = None
    clock_offset_ms: int | None = None
    clock_offset_uncertainty_ms: NonNegative | None = None
    contract_version: str | None = None
    config_fingerprint: SHA256 | None = None
    warnings: tuple[dict[str, object], ...] | None = None


class GeofenceCenter(msgspec.Struct, frozen=True, forbid_unknown_fields=False):
    latitude_deg: Latitude
    longitude_deg: Longitude


class EnvelopeLimits(msgspec.Struct, frozen=True, forbid_unknown_fields=False):
    """The limits so-wayline judges a file against, each under its configuration key."""

    geofence_center: GeofenceCenter
    geofence_radius_m: Positive
    max_height_m: Positive
    max_home_distance_m: Positive
    max_leg_m: Positive
    max_transit_m: Positive
    max_total_distance_m: Positive
    max_waypoints: AtLeastOne
    max_horizontal_speed_ms: Positive


class Envelope(msgspec.Struct, kw_only=True, frozen=True, forbid_unknown_fields=False):
    envelope: EnvelopeLimits
    envelope_fingerprint: SHA256
    config_fingerprint: SHA256
    # Always null from so-wayline, which never hears the phone's configuration (DEP-03).
    application_in_force: bool | None = None


class Check(msgspec.Struct, frozen=True, forbid_unknown_fields=False):
    check: NonEmpty
    status: CheckStatus
    detail: str


class Problem(msgspec.Struct, kw_only=True, frozen=True, forbid_unknown_fields=False):
    """One problem SO named. `waypoint_index` locates it when it belongs to a waypoint."""

    code: RejectionCode
    kind: ProblemKind
    message: NonEmpty
    file: str | None = None
    path: str | None = None
    line: AtLeastOne | None = None
    waypoint_index: NonNegative | None = None
    details: dict[str, object] | None = None


class Report(msgspec.Struct, frozen=True, forbid_unknown_fields=False):
    status: Verdict
    checks: tuple[Check, ...]
    problems: tuple[Problem, ...]


class Validation(msgspec.Struct, frozen=True, forbid_unknown_fields=False):
    """A judgement of a flight file, kept nowhere (FR-LNK-09).

    A REJECTED verdict is an answer, not an error: it comes back with every problem named.
    """

    status: Verdict
    fingerprint_md5: MD5
    size_bytes: NonNegative
    config_fingerprint: SHA256
    # The IR-WAY attributes. The contract describes them without a schema, so they stay open.
    metadata: dict[str, object]
    report: Report


class SoApiError(Exception):
    """A call to so-wayline that gave no usable answer.

    `status` is the HTTP status SO answered with, or None when no complete answer came: a
    transport failure, a timeout, or a body cut short. `body` is what SO said with a refusal,
    or the body a 200 could not be read from, when there was any.
    """

    def __init__(self, message: str, *, status: int | None, body: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class SoApi:
    """so-wayline's HTTP API for one stack, through an aiohttp session the caller owns.

    The token is revealed only to build the Authorization header, so it never shows in a
    repr or an error. Each call is bounded by `timeout_s` in total.
    """

    def __init__(
        self,
        session: aiohttp.ClientSession,
        base_url: str,
        token: soc_config.Secret,
        *,
        timeout_s: float,
    ) -> None:
        if not timeout_s > 0:
            raise ValueError(f"timeout_s must be positive, not {timeout_s!r}")
        self._session = session
        self._url = base_url.rstrip("/")
        self._token = token
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def status(self) -> StackStatus:
        """The stack's state, as so-bridge and so-fleet last published it (FR-LNK-08)."""
        return await self._request("GET", STATUS_PATH, StackStatus)

    async def envelope(self) -> Envelope:
        """The envelope a wayline is judged against (FR-LNK-09)."""
        return await self._request("GET", ENVELOPE_PATH, Envelope)

    async def validate(self, kmz: bytes, *, takeoff: tuple[float, float] | None) -> Validation:
        """Judges a flight file as an upload would, and keeps nothing (FR-LNK-09).

        `takeoff` is the expected takeoff as (latitude_deg, longitude_deg). Without it the
        transit and every point's distance from home are left to the aircraft, and the
        report says so, as SO documents for uploads (FR-WAY-10).
        """
        return await self._request(
            "POST",
            VALIDATIONS_PATH,
            Validation,
            params=_takeoff_query(takeoff),
            body=kmz,
        )

    async def _request[T](
        self,
        method: str,
        path: str,
        kind: type[T],
        *,
        params: Mapping[str, str] | None = None,
        body: bytes | None = None,
    ) -> T:
        headers = {"Authorization": f"Bearer {self._token.reveal()}"}
        if body is not None:
            headers["Content-Type"] = KMZ_CONTENT_TYPE
        try:
            # A redirect is an answer, not followed: the token goes to the configured address only.
            async with self._session.request(
                method,
                self._url + path,
                params=params,
                data=body,
                headers=headers,
                timeout=self._timeout,
                allow_redirects=False,
            ) as response:
                if response.status != HTTPStatus.OK:
                    text = await _refusal_text(response)
                    suffix = "" if text is None else f": {text}"
                    raise SoApiError(
                        f"{method} {path} answered {response.status}{suffix}",
                        status=response.status,
                        body=text,
                    )
                raw = await response.read()
        except TimeoutError as error:
            raise SoApiError(f"{method} {path} timed out", status=None) from error
        except aiohttp.ClientError as error:
            raise SoApiError(f"{method} {path} failed: {describe(error)}", status=None) from error
        try:
            return msgspec.json.decode(raw, type=kind)
        except msgspec.DecodeError as error:
            raise SoApiError(
                f"{method} {path} answered 200 with a body its schema refuses: {describe(error)}",
                status=HTTPStatus.OK,
                body=_text(raw[:BODY_LIMIT_BYTES]),
            ) from error


def _takeoff_query(takeoff: tuple[float, float] | None) -> dict[str, str]:
    """The takeoff as the query names it. Out-of-range values are refused before a call.

    NaN and infinities fail the comparisons too, so they are refused here, not sent.
    """
    if takeoff is None:
        return {}
    latitude_deg, longitude_deg = takeoff
    if not -90 <= latitude_deg <= 90:
        raise ValueError(f"takeoff latitude must be within -90 and 90, not {latitude_deg!r}")
    if not -180 <= longitude_deg <= 180:
        raise ValueError(f"takeoff longitude must be within -180 and 180, not {longitude_deg!r}")
    return {"takeoff_latitude_deg": str(latitude_deg), "takeoff_longitude_deg": str(longitude_deg)}


async def _refusal_text(response: aiohttp.ClientResponse) -> str | None:
    """SO's words with a refusal, read up to BODY_LIMIT_BYTES; None when it said none."""
    try:
        raw = await response.content.read(BODY_LIMIT_BYTES)
    except aiohttp.ClientError, TimeoutError:
        return None
    return _text(raw)


def _text(raw: bytes) -> str | None:
    return raw.decode("utf-8", errors="replace").strip() or None
