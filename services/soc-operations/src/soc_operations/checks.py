"""The preflight checks of FR-OPS-05, judged from what SOC holds (FR-OPS-04, ADR-0025).

`judge` returns the sixteen checks of the table, in its order, from one `Inputs`. It reads no
clock, no database and no socket: `now` is an input, and the caller decides when to judge again
(soc-operations' timer and its notifications, ADR-0025). The same inputs give the same checks.

Freshness (FR-SAF-02). A value is current when it was read no more than
`telemetry_stale_after_ms` before `now`, with the same bound for each kind of value: a sample by
now - received_at (when soc-cloud recorded it), the stack's status by now - status_read_at, and
the envelope by now - envelope_read_at. PF-FRESH fails on a stale sample. Every other check that
reads a stale value is unknown, never pass. A stale or unknown envelope fails PF-ENVELOPE, as
FR-OPS-08 says an unknown one does.

States (FR-SAF-03). A check passes only when every input it needs is present, current and as its
contract gives it. A missing or null input leaves it unknown. A value of another kind than its
contract gives is a fault: it fails the check, naming the field. A status or envelope that does
not match its contract is a fault as a whole, since none of its values can be trusted. A measured
shortfall fails a check even when another input it needs is missing, because a missing value
cannot undo a measured one; soc_geo.fence applies the same rule to a breach.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

import msgspec

from soc_geo import fence
from soc_geo.fence import Geofence
from soc_geo.projection import Geodetic
from soc_geo.sphere import checked, distance_m
from soc_operations.settings import Tunables

type State = Literal["pass", "fail", "unknown"]
type CheckId = Literal[
    "PF-LINK",
    "PF-ONLINE",
    "PF-FRESH",
    "PF-GNSS",
    "PF-BATTERY",
    "PF-GROUNDED",
    "PF-INSIDE",
    "PF-TAKEOFF",
    "PF-WAYLINE",
    "PF-SO-DRYRUN",
    "PF-ENVELOPE",
    "PF-MODE",
    "PF-SIMULATOR",
    "PF-ARMED",
    "PF-IDLE",
    "PF-CLOCK",
]
type DryRunStatus = Literal["pending", "valid", "rejected", "failed"]

#: DJI's flight mode codes on the ground: idle, preparing to take off, ready to take off
#: (apps/soc-web/src/telemetry/format.ts, DJI's DroneModeCodeEnum).
GROUND_MODES = frozenset({0, 1, 2})

#: The health warning an application gives an offset beyond its limit (FR-BRG-13). Sky
#: Orchestrator's application emits it in apps/so-msdk-v4/server/.../msdkv4/server/ClockOffset.kt
#: (CODE); so-bridge passes it through its link state (services/so-bridge/src/so_bridge/bridge.py).
CLOCK_WARNING = "clock_offset"


@dataclass(frozen=True)
class StackView:
    """What SOC holds of the operation's stack, and when it read each part (ADR-0025).

    `link_state` is soc-cloud's MQTT link to the stack: connected, connecting, displaced or
    unreachable. `status` and `envelope` are the responses of /v1/status and /v1/envelope as they
    were given, None when they could not be read; the `*_read_at` times are when soc-cloud read
    each one.
    """

    link_state: str | None
    status: Mapping[str, Any] | None
    status_read_at: datetime | None
    envelope: Mapping[str, Any] | None
    envelope_read_at: datetime | None


@dataclass(frozen=True)
class AircraftView:
    """The operation's aircraft as SOC holds it: its presence and its latest telemetry sample.

    `sample` has the broadcast telemetry shape (contracts/broadcast/telemetry.schema.json), and
    `received_at` is when soc-cloud recorded it.
    """

    online: bool | None
    sample: Mapping[str, Any] | None
    received_at: datetime | None


@dataclass(frozen=True)
class DryRun:
    """Sky Orchestrator's dry run of the flight file: its status and, once judged, its verdict."""

    status: DryRunStatus
    verdict: Mapping[str, Any] | None


@dataclass(frozen=True)
class Inputs:
    """Everything the checks are judged from. `now` is an aware UTC datetime.

    `geofence_ring` is the geofence as stored: [longitude, latitude] positions, not closed.
    `takeoff` is the wayline's takeoff point, [longitude, latitude]. `wayline_problems` is None
    until SOC has judged the wayline, else its problems, empty when it passes. `dry_run` is None
    until one was asked for. `stack_busy` is None when unknown, else whether the stack has an
    unfinished flight other than this operation's own. `tunables` carries the thresholds.
    """

    now: datetime
    stack: StackView | None
    aircraft: AircraftView | None
    geofence_ring: Sequence[Sequence[float]]
    geofence_max_height_m: float
    takeoff: Sequence[float] | None
    wayline_problems: Sequence[str] | None
    dry_run: DryRun | None
    stack_busy: bool | None
    tunables: Tunables


@dataclass(frozen=True)
class Check:
    """One preflight check as judged (FR-OPS-05).

    `value` holds the measured values the check was judged on, JSON-able, or None when it measured
    nothing. `detail` is one sentence saying why, naming the threshold or the vertex.
    """

    check_id: CheckId
    state: State
    blocking: bool
    value: dict[str, Any] | None
    detail: str


def judge(inputs: Inputs) -> tuple[Check, ...]:
    """The sixteen checks of FR-OPS-05, in the table's order, judged from `inputs`."""
    checks: list[Check] = []
    for check_id, blocking, check in _CHECKS:
        reading = check(inputs)
        checks.append(
            Check(
                check_id=check_id,
                state=reading.state,
                blocking=blocking,
                value=reading.value,
                detail=reading.detail,
            )
        )
    return tuple(checks)


def blocking_pass(checks: Iterable[Check]) -> bool:
    """Whether every blocking check passes: the gate of a simulated pass, a launch and ready.

    PF-CLOCK is a warning and does not take part (FR-OPS-05).
    """
    return all(check.state == "pass" for check in checks if check.blocking)


# The stack's and the aircraft's data as the contracts give it. Every field is optional, since a
# missing one is unknown; a field of another kind fails the struct that holds it, by msgspec.


class _Link(msgspec.Struct, frozen=True):
    state: str | None = None
    reason: str | None = None


class _Status(msgspec.Struct, frozen=True):
    """The fields of StackStatus (sky-orchestrator/wayline/openapi.yaml) the checks read."""

    simulator_mode: bool | None = None
    simulator_active: bool | None = None
    armed: bool | None = None
    arming_remaining_s: int | None = None
    clock_offset_ms: int | None = None
    link: _Link | None = None
    warnings: list[dict[str, Any]] | None = None


class _Sample(msgspec.Struct, frozen=True):
    """The fields of the broadcast telemetry sample the checks read."""

    latitude_deg: float | None = None
    longitude_deg: float | None = None
    height_m: float | None = None
    battery_pct: int | None = None
    satellites: int | None = None
    gps_quality: int | None = None
    mode_code: int | None = None


class _Center(msgspec.Struct, frozen=True):
    latitude_deg: float
    longitude_deg: float


class _Limits(msgspec.Struct, frozen=True):
    geofence_center: _Center
    geofence_radius_m: float
    max_height_m: float


class _Envelope(msgspec.Struct, frozen=True):
    """The envelope response (Envelope in openapi.yaml), of which the checks read the circle."""

    envelope: _Limits


class _Problem(msgspec.Struct, frozen=True):
    code: str
    message: str
    waypoint_index: int | None = None


class _Report(msgspec.Struct, frozen=True):
    problems: list[_Problem]


class _Verdict(msgspec.Struct, frozen=True):
    """A dry run's verdict (Validation in openapi.yaml), of which the checks read the problems."""

    report: _Report


@dataclass(frozen=True)
class _Read[T]:
    """One input as the checks read it: its value, or why it is unknown or a fault.

    A fault is a value present but of another kind than its contract gives: it fails the check.
    Unknown is a value missing, null or not current: it leaves the check unknown.
    """

    value: T | None = None
    unknown: str | None = None
    fault: str | None = None


@dataclass(frozen=True)
class _Reading:
    state: State
    detail: str
    value: dict[str, Any] | None = None


class _Findings:
    """What one check found in its inputs: measured faults, and inputs unknown or not current.

    A check fails when anything measured is wrong, whatever else is unknown. It is unknown when
    something needed is missing or not current, and it passes only when nothing was found.
    """

    def __init__(self) -> None:
        self.bad: list[str] = []
        self.unknown: list[str] = []

    def take[T](self, read: _Read[T]) -> T | None:
        """Record what a read found, and return its value when it has one."""
        if read.fault is not None:
            self.bad.append(read.fault)
        if read.unknown is not None:
            self.unknown.append(read.unknown)
        return read.value

    def reading(self, passed: str, value: dict[str, Any] | None) -> _Reading:
        """The check's reading, with `passed` as its sentence when nothing was found."""
        if self.bad:
            return _Reading("fail", _sentence("; ".join(self.bad)), value)
        if self.unknown:
            return _Reading("unknown", _sentence("; ".join(self.unknown)), value)
        return _Reading("pass", passed, value)


def _sentence(text: str) -> str:
    """`text` as one sentence: its first letter capitalised, and a full stop at its end."""
    head = text[:1].upper() + text[1:]
    return head if head.endswith(".") else head + "."


def _seconds(milliseconds: float) -> str:
    return f"{milliseconds / 1000:.1f} s"


def _age_ms(now: datetime, read_at: datetime | None) -> float | None:
    """Milliseconds from `read_at` to `now`: negative when `read_at` is later, None when unknown."""
    if read_at is None:
        return None
    return (now - read_at) / timedelta(milliseconds=1)


def _read[T: msgspec.Struct](
    now: datetime,
    raw: Mapping[str, Any] | None,
    read_at: datetime | None,
    kind: type[T],
    what: str,
    stale_after_ms: int,
) -> _Read[T]:
    """`raw` as `kind`, when it is present, current, and of the kind its contract gives.

    A read further in the future than the threshold has no usable time either: its age cannot
    be trusted, so it is not current (FR-SAF-02).
    """
    if raw is None:
        return _Read(unknown=f"{what} is not known")
    age_ms = _age_ms(now, read_at)
    if age_ms is None or age_ms < -stale_after_ms:
        return _Read(unknown=f"{what} has no usable read time")
    if age_ms > stale_after_ms:
        return _Read(
            unknown=f"{what} is {_seconds(age_ms)} old, past telemetry_stale_after_ms "
            f"{stale_after_ms}"
        )
    try:
        return _Read(value=msgspec.convert(raw, kind, strict=True))
    except msgspec.ValidationError as error:
        return _Read(fault=f"{what} cannot be read: {error}")


def _read_status(inputs: Inputs) -> _Read[_Status]:
    stack = inputs.stack
    raw = None if stack is None else stack.status
    read_at = None if stack is None else stack.status_read_at
    return _read(
        inputs.now,
        raw,
        read_at,
        _Status,
        "the stack's status",
        inputs.tunables.telemetry_stale_after_ms,
    )


def _read_envelope(inputs: Inputs) -> _Read[_Envelope]:
    stack = inputs.stack
    raw = None if stack is None else stack.envelope
    read_at = None if stack is None else stack.envelope_read_at
    return _read(
        inputs.now,
        raw,
        read_at,
        _Envelope,
        "the stack's envelope",
        inputs.tunables.telemetry_stale_after_ms,
    )


def _read_sample(inputs: Inputs) -> _Read[_Sample]:
    aircraft = inputs.aircraft
    raw = None if aircraft is None else aircraft.sample
    received_at = None if aircraft is None else aircraft.received_at
    return _read(
        inputs.now,
        raw,
        received_at,
        _Sample,
        "the latest telemetry sample",
        inputs.tunables.telemetry_stale_after_ms,
    )


def _position(pair: Sequence[float]) -> Geodetic:
    """A stored [longitude, latitude] pair as a position, refused unless it is one."""
    if len(pair) != 2:
        raise ValueError(f"a position is a [longitude, latitude] pair, not {list(pair)}")
    longitude, latitude = pair
    return checked(Geodetic(latitude_deg=latitude, longitude_deg=longitude))


def _vertices(ring: Sequence[Sequence[float]]) -> tuple[Geodetic, ...]:
    """The geofence's vertices as positions, refused when there are none or one is unplaceable."""
    if not ring:
        raise ValueError("the geofence has no vertices")
    vertices: list[Geodetic] = []
    for index, pair in enumerate(ring):
        try:
            vertices.append(_position(pair))
        except ValueError as error:
            raise ValueError(f"vertex {index} is not a position: {error}") from error
    return tuple(vertices)


def _geofence(inputs: Inputs) -> Geofence:
    """The geofence as soc_geo.fence judges it, refused when it cannot be judged.

    The local frame (ADR-0014) is tangent to the ellipsoid at its origin. The origin is the mean
    of the vertices, a point inside the site, so the plane touches the ellipsoid where the geofence
    and the aircraft are. This is a convention: the stored ring does not name an origin.
    """
    vertices = _vertices(inputs.geofence_ring)
    count = len(vertices)
    origin = Geodetic(
        latitude_deg=sum(vertex.latitude_deg for vertex in vertices) / count,
        longitude_deg=sum(vertex.longitude_deg for vertex in vertices) / count,
    )
    return fence.geofence_of(origin, inputs.geofence_ring, inputs.geofence_max_height_m)


def _link(inputs: Inputs) -> _Reading:
    """PF-LINK: the stack's link is connected to soc-cloud, and up on the stack's own status.

    A link that is not connected fails the check, as does a status that says the link is down.
    """
    stack = inputs.stack
    findings = _Findings()
    link_state = None if stack is None else stack.link_state
    if link_state is None:
        findings.unknown.append("the stack's link state is not known")
    elif link_state != "connected":
        findings.bad.append(f"the link to the stack is {link_state}, not connected")
    state: str | None = None
    status = findings.take(_read_status(inputs))
    if status is not None:
        link = status.link
        state = None if link is None else link.state
        if state is None:
            findings.unknown.append("the stack reports no link state")
        elif state != "up":
            reason = "" if link is None or link.reason is None else f" ({link.reason})"
            findings.bad.append(f"the stack's link is {state}{reason}")
    value = {"link_state": link_state, "stack_link_state": state}
    return findings.reading("The link to the stack is connected and up.", value)


def _online(inputs: Inputs) -> _Reading:
    """PF-ONLINE: the aircraft is online in the topology, over a link that is connected.

    A link that is not connected fails the check rather than leaving it unknown: with no link
    there is no current topology, so the aircraft cannot be shown online (FR-LNK-02).
    """
    stack, aircraft = inputs.stack, inputs.aircraft
    link_state = None if stack is None else stack.link_state
    online = None if aircraft is None else aircraft.online
    findings = _Findings()
    if online is False:
        findings.bad.append("the aircraft is offline in the topology")
    elif online is None:
        findings.unknown.append("the aircraft's presence is not known")
    if link_state is None:
        findings.unknown.append("the stack's link state is not known")
    elif link_state != "connected":
        findings.bad.append(f"the link to the stack is {link_state}, so the topology is stale")
    value = {"online": online, "link_state": link_state}
    return findings.reading("The aircraft is online in the topology over a connected link.", value)


def _fresh(inputs: Inputs) -> _Reading:
    """PF-FRESH: the latest telemetry sample is current, by its record time (FR-SAF-02).

    This is the one check a stale sample fails rather than leaves unknown: its age is the fact.
    """
    aircraft = inputs.aircraft
    if aircraft is None or aircraft.sample is None:
        return _Reading("unknown", "No telemetry sample is known.")
    stale_after_ms = inputs.tunables.telemetry_stale_after_ms
    age_ms = _age_ms(inputs.now, aircraft.received_at)
    if age_ms is None or age_ms < -stale_after_ms:
        return _Reading(
            "unknown", "The latest telemetry sample has no usable record time.", {"age_ms": None}
        )
    value = {"age_ms": round(age_ms)}
    if age_ms > stale_after_ms:
        return _Reading(
            "fail",
            f"The latest telemetry sample was recorded {_seconds(age_ms)} ago, past "
            f"telemetry_stale_after_ms {stale_after_ms}.",
            value,
        )
    return _Reading(
        "pass",
        f"The latest telemetry sample was recorded {_seconds(max(age_ms, 0.0))} ago, within "
        f"telemetry_stale_after_ms {stale_after_ms}.",
        value,
    )


def _gnss(inputs: Inputs) -> _Reading:
    """PF-GNSS: satellites reach min_satellites and the positioning quality min_gps_quality."""
    findings = _Findings()
    sample = findings.take(_read_sample(inputs))
    if sample is None:
        return findings.reading("", None)
    minimum_satellites = inputs.tunables.min_satellites
    minimum_quality = inputs.tunables.min_gps_quality
    if sample.satellites is None:
        findings.unknown.append("the satellite count is not known")
    elif sample.satellites < minimum_satellites:
        findings.bad.append(
            f"{sample.satellites} satellites are under min_satellites {minimum_satellites}"
        )
    if sample.gps_quality is None:
        findings.unknown.append("the positioning quality is not known")
    elif sample.gps_quality < minimum_quality:
        findings.bad.append(
            f"positioning quality {sample.gps_quality} is under min_gps_quality {minimum_quality}"
        )
    value = {"satellites": sample.satellites, "gps_quality": sample.gps_quality}
    passed = (
        f"Satellites {sample.satellites} and positioning quality {sample.gps_quality} reach "
        f"min_satellites {minimum_satellites} and min_gps_quality {minimum_quality}."
    )
    return findings.reading(passed, value)


def _battery(inputs: Inputs) -> _Reading:
    """PF-BATTERY: the battery reaches min_battery_start_pct."""
    findings = _Findings()
    sample = findings.take(_read_sample(inputs))
    if sample is None:
        return findings.reading("", None)
    minimum = inputs.tunables.min_battery_start_pct
    level = sample.battery_pct
    if level is None:
        findings.unknown.append("the battery level is not known")
    elif level < minimum:
        findings.bad.append(f"the battery is at {level}%, under min_battery_start_pct {minimum}%")
    passed = f"The battery is at {level}%, at least min_battery_start_pct {minimum}%."
    return findings.reading(passed, {"battery_pct": level})


def _grounded(inputs: Inputs) -> _Reading:
    """PF-GROUNDED: the aircraft's flight mode is one of the ground modes, 0, 1 or 2."""
    findings = _Findings()
    sample = findings.take(_read_sample(inputs))
    if sample is None:
        return findings.reading("", None)
    code = sample.mode_code
    if code is None:
        findings.unknown.append("the flight mode is not known")
    elif code not in GROUND_MODES:
        findings.bad.append(f"the aircraft is in mode {code}, not on the ground (modes 0, 1, 2)")
    passed = f"The aircraft is on the ground, in mode {code}."
    return findings.reading(passed, {"mode_code": code})


def _inside(inputs: Inputs) -> _Reading:
    """PF-INSIDE: the aircraft is inside the geofence, its ceiling included (FR-SAF-01).

    The judgement is soc_geo.fence's, the same the cloud geofence makes, so the gate and the
    cloud agree. It passes inside and on a warning band alike. The band is judged here as zero,
    which only decides whether a sample exactly on the boundary is called "warning" rather than
    "inside": the state is pass for both, so the console's band (geofence_warning_band_m, which
    soc-cloud reads) is not an input of this check.
    """
    try:
        geofence = _geofence(inputs)
    except ValueError as error:
        return _Reading("fail", _sentence(str(error)))
    findings = _Findings()
    sample = findings.take(_read_sample(inputs))
    if sample is None:
        return findings.reading("", None)
    position: Geodetic | None = None
    if sample.latitude_deg is not None and sample.longitude_deg is not None:
        position = Geodetic(latitude_deg=sample.latitude_deg, longitude_deg=sample.longitude_deg)
    judgement = fence.judge(geofence, position, sample.height_m, warning_band_m=0.0)
    value = {
        "distance_to_boundary_m": _rounded(judgement.distance_to_boundary_m),
        "distance_outside_m": _rounded(judgement.distance_outside_m),
        "above_ceiling_m": _rounded(judgement.above_ceiling_m),
    }
    boundary = judgement.distance_to_boundary_m
    if judgement.verdict is fence.Verdict.OUTSIDE:
        return _Reading("fail", _sentence(f"the aircraft is {judgement.reason}"), value)
    if judgement.verdict is fence.Verdict.UNKNOWN or boundary is None:
        why = judgement.reason.removeprefix("unknown: ")
        return _Reading(
            "unknown",
            _sentence(f"the aircraft's place against the geofence is not known: {why}"),
            value,
        )
    return _Reading(
        "pass",
        f"The aircraft is inside the geofence, {boundary:.1f} m from its boundary.",
        value,
    )


def _rounded(metres: float | None) -> float | None:
    return None if metres is None else round(metres, 2)


def _takeoff(inputs: Inputs) -> _Reading:
    """PF-TAKEOFF: the aircraft is within takeoff_tolerance_m of the wayline's takeoff point.

    Measured as Sky Orchestrator measures its limits (soc_geo.sphere).
    """
    if inputs.takeoff is None:
        return _Reading("unknown", "The wayline's takeoff point is not known.")
    try:
        takeoff = _position(inputs.takeoff)
    except ValueError as error:
        return _Reading("fail", _sentence(f"the takeoff point is not a position: {error}"))
    findings = _Findings()
    sample = findings.take(_read_sample(inputs))
    if sample is None:
        return findings.reading("", None)
    if sample.latitude_deg is None or sample.longitude_deg is None:
        findings.unknown.append("the aircraft's position is not known")
        return findings.reading("", None)
    try:
        here = checked(
            Geodetic(latitude_deg=sample.latitude_deg, longitude_deg=sample.longitude_deg)
        )
    except ValueError:
        findings.unknown.append("the aircraft's position is not a position")
        return findings.reading("", None)
    metres = distance_m(here, takeoff)
    tolerance = inputs.tunables.takeoff_tolerance_m
    value = {"distance_m": round(metres, 2)}
    if metres > tolerance:
        findings.bad.append(
            f"the aircraft is {metres:.1f} m from the takeoff point, over takeoff_tolerance_m "
            f"{tolerance:.1f} m"
        )
    passed = (
        f"The aircraft is {metres:.1f} m from the takeoff point, within takeoff_tolerance_m "
        f"{tolerance:.1f} m."
    )
    return findings.reading(passed, value)


def _wayline(inputs: Inputs) -> _Reading:
    """PF-WAYLINE: SOC's own validation of the wayline passes, with every problem it names."""
    problems = inputs.wayline_problems
    if problems is None:
        return _Reading("unknown", "The wayline has not been judged yet.")
    value = {"problems": list(problems)}
    if problems:
        return _Reading(
            "fail", _sentence("SOC's validation fails the wayline: " + "; ".join(problems)), value
        )
    return _Reading("pass", "SOC's validation passes the wayline.", value)


def _dry_run(inputs: Inputs) -> _Reading:
    """PF-SO-DRYRUN: Sky Orchestrator's dry run accepts the flight file (FR-LNK-09).

    A refusal fails the check with every problem SO's verdict names, each with its waypoint in
    `value`. A dry run still pending or failed is unknown: it has said nothing to judge.
    """
    dry = inputs.dry_run
    if dry is None:
        return _Reading("unknown", "No dry run has been asked for this flight file.")
    if dry.status == "valid":
        return _Reading("pass", "Sky Orchestrator's dry run accepts the flight file.")
    if dry.status == "rejected":
        return _rejected(dry.verdict)
    if dry.status == "pending":
        return _Reading("unknown", "Sky Orchestrator's dry run is still pending.")
    return _Reading("unknown", "The dry run failed, so Sky Orchestrator's verdict is not known.")


def _rejected(verdict: Mapping[str, Any] | None) -> _Reading:
    try:
        problems = msgspec.convert(verdict, _Verdict, strict=True).report.problems
    except msgspec.ValidationError as error:
        unreadable = f"its verdict cannot be read: {error}"
        return _Reading(
            "fail", _sentence(f"Sky Orchestrator rejected the flight file, and {unreadable}")
        )
    value = {
        "status": "rejected",
        "problems": [
            {"code": problem.code, "waypoint_index": problem.waypoint_index} for problem in problems
        ],
    }
    if not problems:
        return _Reading(
            "fail", "Sky Orchestrator rejected the flight file without naming a problem.", value
        )
    named = "; ".join(problem.message for problem in problems)
    return _Reading("fail", _sentence(f"Sky Orchestrator rejected the flight file: {named}"), value)


def _envelope(inputs: Inputs) -> _Reading:
    """PF-ENVELOPE: the geofence lies inside the stack's device envelope (FR-OPS-08).

    Every stored vertex must lie within the envelope's circle, measured as Sky Orchestrator
    measures its limits (soc_geo.sphere; a value exactly at the radius passes), and the geofence's
    ceiling within the envelope's max_height_m. An envelope that is unknown, stale or unreadable
    fails the check: FR-OPS-08 says so for an unknown one, and a stale one is not known to be
    current. So this check has no unknown state.
    """
    read = _read_envelope(inputs)
    if read.value is None:
        reason = read.unknown or read.fault or "the envelope is not known"
        return _Reading("fail", _sentence(f"{reason}, which fails the check (FR-OPS-08)"))
    limits = read.value.envelope
    try:
        center = checked(
            Geodetic(
                latitude_deg=limits.geofence_center.latitude_deg,
                longitude_deg=limits.geofence_center.longitude_deg,
            )
        )
        vertices = _vertices(inputs.geofence_ring)
    except ValueError as error:
        return _Reading(
            "fail",
            _sentence(f"the geofence cannot be judged against the envelope: {error}"),
        )
    radius = limits.geofence_radius_m
    ceiling = inputs.geofence_max_height_m
    value = {
        "radius_m": radius,
        "envelope_max_height_m": limits.max_height_m,
        "ceiling_m": ceiling,
    }
    for index, vertex in enumerate(vertices):
        beyond = distance_m(center, vertex) - radius
        if not beyond <= 0.0:  # a radius that is not a number fails too
            return _Reading(
                "fail",
                _sentence(
                    f"vertex {index} lies {beyond:.1f} m outside the envelope's {radius:.1f} m "
                    "circle"
                ),
                value,
            )
    if not ceiling <= limits.max_height_m:
        return _Reading(
            "fail",
            _sentence(
                f"the geofence's ceiling of {ceiling:.1f} m is above the envelope's "
                f"max_height_m {limits.max_height_m:.1f} m"
            ),
            value,
        )
    passed = (
        f"All {len(vertices)} vertices lie within the envelope's {radius:.1f} m circle, and the "
        f"{ceiling:.1f} m ceiling is within its {limits.max_height_m:.1f} m limit."
    )
    return _Reading("pass", passed, value)


def _mode(inputs: Inputs) -> _Reading:
    """PF-MODE: the stack's simulator mode is known.

    Both modes pass: what the mode must agree with is PF-SIMULATOR's. A null mode is unknown, as
    FR-LNK-08 requires, and so is a status that is not current (FR-SAF-02). FR-SAF-04 refuses any
    prepare while the mode is unknown, and PF-MODE blocks as every blocking check does. A mode
    that is neither a boolean nor null is the stack's reply being wrong, not a gap, so it fails
    and the field is named.
    """
    findings = _Findings()
    status = findings.take(_read_status(inputs))
    if status is None:
        return findings.reading("", None)
    mode = status.simulator_mode
    if mode is None:
        findings.unknown.append("the stack reports no simulator mode")
    passed = f"The stack is in {'simulator' if mode else 'real'} mode."
    return findings.reading(passed, {"simulator_mode": mode})


def _simulator(inputs: Inputs) -> _Reading:
    """PF-SIMULATOR: the phone's simulator agrees with the stack's mode.

    On in simulator mode, off in real mode, as `simulator_active` is set against
    `simulator_mode`. In real mode a phone still in its simulator refuses the execute
    (dependencies.md, "What SO #126 changes for real flight"), which is why SOC checks it before
    executing rather than learning it from a refusal. A disagreement names the one thing the
    operator must do on the phone.
    """
    findings = _Findings()
    status = findings.take(_read_status(inputs))
    if status is None:
        return findings.reading("", None)
    mode, active = status.simulator_mode, status.simulator_active
    value = {"simulator_mode": mode, "simulator_active": active}
    if mode is None:
        findings.unknown.append("the stack's simulator mode is not known")
    if active is None:
        findings.unknown.append("the phone's simulator state is not known")
    if mode is not None and active is not None and mode != active:
        if mode:
            findings.bad.append("the stack is in simulator mode: turn the phone's simulator on")
        else:
            findings.bad.append("the stack is in real mode: turn the phone's simulator off")
    passed = (
        "The phone's simulator is on, as simulator mode requires."
        if mode
        else "The phone's simulator is off, as real mode requires."
    )
    return findings.reading(passed, value)


def _armed(inputs: Inputs) -> _Reading:
    """PF-ARMED: the operator armed the phone, with at least min_arming_left_s left.

    The seconds left are judged as the stack reported them, not advanced by the time since the
    read. The status is current, so that time is at most telemetry_stale_after_ms, the bound
    FR-SAF-02 sets for every status value.
    """
    findings = _Findings()
    status = findings.take(_read_status(inputs))
    if status is None:
        return findings.reading("", None)
    armed, left = status.armed, status.arming_remaining_s
    minimum = inputs.tunables.min_arming_left_s
    value = {"armed": armed, "arming_remaining_s": left}
    if armed is False:
        findings.bad.append("the operator has not armed the phone")
    elif armed is None:
        findings.unknown.append("whether the operator armed the phone is not known")
    if left is None:
        findings.unknown.append("the seconds left of the arming are not known")
    elif left < minimum:
        findings.bad.append(f"the arming has {left} s left, under min_arming_left_s {minimum}")
    passed = f"The phone is armed, with {left} s left, at least min_arming_left_s {minimum}."
    return findings.reading(passed, value)


def _idle(inputs: Inputs) -> _Reading:
    """PF-IDLE: the stack has no unfinished flight other than this operation's own."""
    busy = inputs.stack_busy
    value = {"stack_busy": busy}
    if busy is None:
        return _Reading(
            "unknown", "Whether the stack has an unfinished flight is not known.", value
        )
    if busy:
        return _Reading(
            "fail", "The stack has an unfinished flight other than this operation's own.", value
        )
    return _Reading("pass", "The stack has no unfinished flight.", value)


def _clock(inputs: Inputs) -> _Reading:
    """PF-CLOCK (a warning, not blocking): the stack's clock is within its bound.

    The bound is the application's (`clock_offset_warn_ms` in Sky Orchestrator's so-config): its
    warning says the offset is beyond it. The check reads that warning rather than comparing the
    offset with a limit SOC does not hold. The offset is the measured value; the warning is the
    judgement.
    """
    findings = _Findings()
    status = findings.take(_read_status(inputs))
    if status is None:
        return findings.reading("", None)
    offset, warnings = status.clock_offset_ms, status.warnings
    if offset is None:
        findings.unknown.append("the stack's clock offset is not known")
    clock: list[dict[str, Any]] = []
    if warnings is None:
        findings.unknown.append("the stack's health warnings are not known")
    else:
        clock = [warning for warning in warnings if warning.get("code") == CLOCK_WARNING]
        if any(not isinstance(warning.get("code"), str) for warning in warnings):
            findings.unknown.append("a health warning does not name its code")
    if clock:
        measured = clock[0].get("measured_ms")
        at = "" if measured is None else f" at {measured} ms"
        findings.bad.append(f"the stack's health reports a {CLOCK_WARNING} warning{at}")
    value = {"clock_offset_ms": offset, "clock_warning": bool(clock)}
    passed = f"The stack's clock is {offset} ms off, with no clock warning."
    return findings.reading(passed, value)


_CHECKS: tuple[tuple[CheckId, bool, Callable[[Inputs], _Reading]], ...] = (
    ("PF-LINK", True, _link),
    ("PF-ONLINE", True, _online),
    ("PF-FRESH", True, _fresh),
    ("PF-GNSS", True, _gnss),
    ("PF-BATTERY", True, _battery),
    ("PF-GROUNDED", True, _grounded),
    ("PF-INSIDE", True, _inside),
    ("PF-TAKEOFF", True, _takeoff),
    ("PF-WAYLINE", True, _wayline),
    ("PF-SO-DRYRUN", True, _dry_run),
    ("PF-ENVELOPE", True, _envelope),
    ("PF-MODE", True, _mode),
    ("PF-SIMULATOR", True, _simulator),
    ("PF-ARMED", True, _armed),
    ("PF-IDLE", True, _idle),
    ("PF-CLOCK", False, _clock),
)
