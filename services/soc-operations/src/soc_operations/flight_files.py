"""A wayline's flight file: the KMZ that Sky Orchestrator's dock downloads (FR-WAY-11, ADR-0008).

The baked wayline becomes two files, laid out as DJI's WPML has them. ``wpmz/template.kml``
is the planning file, which Sky Orchestrator reads for its name and template type only.
``wpmz/waylines.wpml`` is the execution file, the one that is flown. Every element written
is in Sky Orchestrator's accepted subset (``contracts/sky-orchestrator/wpml/supported-subset.md``),
and the tests hold the output to that page's own tables.

The same bake and name always give the same bytes: a fixed entry order and timestamp, a fixed
deflate level and attributes, no comment and no extra fields. A bake's positions are
``[longitude, latitude]``. DJI's order, latitude first in ``takeOffRefPoint``, is translated
here and nowhere else.
"""

from __future__ import annotations

import hashlib
import io
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from xml.parsers import expat
from xml.sax.saxutils import escape

WPML_NAMESPACE = "http://www.dji.com/wpmz/1.0.2"
KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
TEMPLATE_PATH = "wpmz/template.kml"
WAYLINES_PATH = "wpmz/waylines.wpml"

# The subset's bounds (supported-subset.md): heights and the security height in (0, 120] m,
# speeds in (0, 15] m/s.
MAX_HEIGHT_M = 120.0
MAX_SPEED_MS = 15.0

# Sky Orchestrator's finish_action names for the bake's three, as DJI's finishAction spells them.
FINISH_ACTIONS = {"return_home": "goHome", "hold": "noAction", "land": "autoLand"}
DJI_FINISH_ACTIONS = {dji: bake for bake, dji in FINISH_ACTIONS.items()}

# A fixed archive: no clock, no platform default, no comment, no extra fields.
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
ZIP_CREATE_SYSTEM = 3  # Unix, whichever platform builds the file
ZIP_ATTRIBUTES = 0o644 << 16
ZIP_COMPRESSION_LEVEL = 9

INDENT = "  "
DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
KML_OPEN = f'<kml xmlns="{KML_NAMESPACE}" xmlns:wpml="{WPML_NAMESPACE}">'

# What XML 1.0 cannot carry, and every control character besides: a name has no line breaks
# or tabs, and a parser would normalise a carriage return, so the name would not read back.
_XML_UNSAFE = re.compile(r"[\x00-\x1f\ud800-\udfff\ufffe\uffff]")


@dataclass(frozen=True)
class _Waypoint:
    index: int
    position: tuple[float, float]
    height_m: float
    speed_ms: float | None  # the speed into this waypoint, when the bake gives one


@dataclass(frozen=True)
class _Wayline:
    name: str
    reference_point: tuple[float, float]
    takeoff_security_height_m: float
    speed_ms: float
    finish_action: str
    waypoints: tuple[_Waypoint, ...]


def build(baked: Mapping[str, Any], *, name: str) -> bytes:
    """The KMZ for a bake. The same bake and name always give the same bytes.

    Raises ValueError, naming the problem, for anything the subset cannot fly, and for a bake
    with violations (FR-WAY-08): a flight file is only ever built from a clean bake. Nothing
    is produced for a refused bake.
    """
    wayline = _wayline(baked, name)
    return _archive(
        ((TEMPLATE_PATH, _template_text(wayline)), (WAYLINES_PATH, _waylines_text(wayline)))
    )


def fingerprint(kmz: bytes) -> str:
    """The MD5 hex digest of a flight file, as Sky Orchestrator's plan records it."""
    # Identification, not security: the digest must match what the dock computes.
    return hashlib.md5(kmz, usedforsecurity=False).hexdigest()


def read(kmz: bytes) -> dict[str, Any]:
    """The bake's fields back from a flight file this module wrote, for the round-trip tests.

    Refuses a DOCTYPE or an entity declaration, and anything not shaped the way the module
    writes it.
    """
    root = _parse(_members(kmz)[WAYLINES_PATH])
    if root.tag != _kml("kml"):
        raise ValueError(f"the root element is {_local(root.tag)}, not kml")
    document = _only(root, _kml("Document"))
    mission = _only(document, _wpml("missionConfig"))
    folder = _only(document, _kml("Folder"))

    longitude, latitude = _reference_point(_text(mission, _wpml("takeOffRefPoint")))
    transit = float(_text(mission, _wpml("globalTransitionalSpeed")))
    speed = float(_text(folder, _wpml("autoFlightSpeed")))
    if transit != speed:
        raise ValueError(f"the transit speed {transit} and the flight speed {speed} differ")
    dji_finish = _text(mission, _wpml("finishAction"))
    if dji_finish not in DJI_FINISH_ACTIONS:
        raise ValueError(f"finishAction {dji_finish!r} is not one this module writes")
    return {
        "reference_point": [longitude, latitude],
        "takeoff_security_height_m": float(_text(mission, _wpml("takeOffSecurityHeight"))),
        "speed_ms": speed,
        "finish_action": DJI_FINISH_ACTIONS[dji_finish],
        "waypoints": [
            _read_placemark(placemark) for placemark in folder.findall(_kml("Placemark"))
        ],
    }


# --- validation: the bake, refused whole or accepted whole -------------------------------


def _wayline(baked: Mapping[str, Any], name: str) -> _Wayline:
    _clean(_field(baked, "violations"))
    speed = _bounded(_field(baked, "speed_ms"), MAX_SPEED_MS, "speed_ms", "m/s")
    waypoints = _waypoints(_field(baked, "waypoints"))
    # The file has no speed for the transit into waypoint 0: that leg flies at the wayline's
    # speed. A different speed given for it is refused, not dropped.
    first_speed = waypoints[0].speed_ms
    if first_speed is not None and first_speed != speed:
        raise ValueError(
            f"waypoint 0 speed_ms {first_speed:g} differs from the wayline's {speed:g} m/s: "
            "the transit into waypoint 0 flies at the wayline's speed in a flight file"
        )
    return _Wayline(
        name=_name(name),
        reference_point=_position(_field(baked, "reference_point"), "reference_point"),
        takeoff_security_height_m=_bounded(
            _field(baked, "takeoff_security_height_m"),
            MAX_HEIGHT_M,
            "takeoff_security_height_m",
            "m",
        ),
        speed_ms=speed,
        finish_action=_finish_action(_field(baked, "finish_action")),
        waypoints=waypoints,
    )


def _clean(violations: object) -> None:
    if not isinstance(violations, list | tuple):
        raise ValueError("violations is not a list")
    if violations:
        told = "; ".join(_violation(violation) for violation in violations)
        raise ValueError(f"the bake breaks {len(violations)} rule(s), so it does not fly: {told}")


def _violation(violation: object) -> str:
    if not isinstance(violation, Mapping):
        return repr(violation)
    where = violation.get("waypoint_index")
    at = "" if where is None else f" at waypoint {where}"
    return f"{violation.get('rule')}{at}"


def _name(name: str) -> str:
    if not name.strip():
        raise ValueError("the wayline has no name")
    if _XML_UNSAFE.search(name):
        raise ValueError(
            f"the wayline's name {name!r} holds a character XML cannot carry (a control character)"
        )
    return name


def _finish_action(value: object) -> str:
    if isinstance(value, str) and value in FINISH_ACTIONS:
        return value
    raise ValueError(f"finish_action {value!r} is not one of {', '.join(FINISH_ACTIONS)}")


def _waypoints(value: object) -> tuple[_Waypoint, ...]:
    if not isinstance(value, list | tuple):
        raise ValueError("waypoints is not a list")
    if not value:
        raise ValueError("the bake has no waypoint: a flight file flies at least one")
    return tuple(_waypoint(raw, position) for position, raw in enumerate(value))


def _waypoint(raw: object, position: int) -> _Waypoint:
    if not isinstance(raw, Mapping):
        raise ValueError(f"waypoint at position {position} is not an object")
    index = raw.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index != position:
        raise ValueError(
            f"waypoint at position {position} has index {index!r}, out of order: "
            "indexes run 0, 1, 2 in order"
        )
    if raw.get("actions"):
        raise ValueError(
            f"waypoint {index} has actions, which the flight file does not write yet (FR-WAY-12)"
        )
    label = f"waypoint {index}"
    return _Waypoint(
        index=index,
        position=_position(_field(raw, "position", label), f"{label} position"),
        height_m=_bounded(_field(raw, "height_m", label), MAX_HEIGHT_M, f"{label} height_m", "m"),
        speed_ms=(
            _bounded(raw["speed_ms"], MAX_SPEED_MS, f"{label} speed_ms", "m/s")
            if "speed_ms" in raw
            else None
        ),
    )


def _field(mapping: Mapping[str, Any], key: str, where: str = "the bake") -> Any:
    if key not in mapping:
        raise ValueError(f"{where} has no {key}")
    return mapping[key]


def _real(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _position(value: object, what: str) -> tuple[float, float]:
    if isinstance(value, list | tuple) and len(value) == 2:
        longitude, latitude = _real(value[0]), _real(value[1])
        if (
            longitude is not None
            and latitude is not None
            and -180 <= longitude <= 180
            and -90 <= latitude <= 90
        ):
            return (longitude, latitude)
    raise ValueError(
        f"{what} {value!r} is not two finite numbers in range: "
        "longitude in [-180, 180], latitude in [-90, 90]"
    )


def _bounded(value: object, high: float, what: str, unit: str) -> float:
    number = _real(value)
    if number is not None and 0 < number <= high:
        return number
    raise ValueError(f"{what} {value!r} is not in (0, {high:g}] {unit}")


# --- the two files, as text --------------------------------------------------------------


def _template_text(wayline: _Wayline) -> str:
    return _document(
        [
            _leaf(2, "name", escape(wayline.name)),
            *_mission_config(wayline),
            _open(2, "Folder"),
            _leaf(3, "wpml:templateType", "waypoint"),
            _leaf(3, "wpml:templateId", "0"),
            _close(2, "Folder"),
        ]
    )


def _waylines_text(wayline: _Wayline) -> str:
    placemarks = [
        line for position in range(len(wayline.waypoints)) for line in _placemark(wayline, position)
    ]
    return _document(
        [
            *_mission_config(wayline),
            _open(2, "Folder"),
            _leaf(3, "wpml:templateId", "0"),
            _leaf(3, "wpml:executeHeightMode", "relativeToStartPoint"),
            _leaf(3, "wpml:waylineId", "0"),
            _leaf(3, "wpml:autoFlightSpeed", _number(wayline.speed_ms)),
            *placemarks,
            _close(2, "Folder"),
        ]
    )


def _mission_config(wayline: _Wayline) -> list[str]:
    longitude, latitude = wayline.reference_point
    return [
        _open(2, "wpml:missionConfig"),
        _leaf(3, "wpml:flyToWaylineMode", "safely"),
        _leaf(3, "wpml:finishAction", FINISH_ACTIONS[wayline.finish_action]),
        _leaf(3, "wpml:exitOnRCLost", "executeLostAction"),
        _leaf(3, "wpml:executeRCLostAction", "goBack"),
        _leaf(3, "wpml:takeOffSecurityHeight", _number(wayline.takeoff_security_height_m)),
        # DJI's order: latitude, then longitude, then the height of the takeoff point itself (0).
        _leaf(3, "wpml:takeOffRefPoint", f"{_number(latitude)},{_number(longitude)},0"),
        _leaf(3, "wpml:globalTransitionalSpeed", _number(wayline.speed_ms)),
        _close(2, "wpml:missionConfig"),
    ]


def _placemark(wayline: _Wayline, position: int) -> list[str]:
    waypoint = wayline.waypoints[position]
    longitude, latitude = waypoint.position
    return [
        _open(3, "Placemark"),
        _open(4, "Point"),
        _leaf(5, "coordinates", f"{_number(longitude)},{_number(latitude)}"),
        _close(4, "Point"),
        _leaf(4, "wpml:index", str(waypoint.index)),
        _leaf(4, "wpml:executeHeight", _number(waypoint.height_m)),
        _leaf(4, "wpml:waypointSpeed", _number(_outgoing_speed(wayline, position))),
        _open(4, "wpml:waypointHeadingParam"),
        _leaf(5, "wpml:waypointHeadingMode", "fixed"),
        _close(4, "wpml:waypointHeadingParam"),
        _open(4, "wpml:waypointTurnParam"),
        _leaf(5, "wpml:waypointTurnMode", "toPointAndStopWithDiscontinuityCurvature"),
        _close(4, "wpml:waypointTurnParam"),
        _close(3, "Placemark"),
    ]


def _outgoing_speed(wayline: _Wayline, position: int) -> float:
    """The speed on the leg out of a waypoint: the next waypoint's own speed, else the wayline's.

    The leg into the next waypoint is the one this placemark's wpml:waypointSpeed sets.
    """
    if position + 1 < len(wayline.waypoints):
        following = wayline.waypoints[position + 1].speed_ms
        if following is not None:
            return following
    return wayline.speed_ms


def _document(body: Iterable[str]) -> str:
    lines = [DECLARATION, KML_OPEN, _open(1, "Document"), *body, _close(1, "Document"), "</kml>"]
    return "\n".join(lines) + "\n"


def _line(depth: int, text: str) -> str:
    return INDENT * depth + text


def _open(depth: int, tag: str) -> str:
    return _line(depth, f"<{tag}>")


def _close(depth: int, tag: str) -> str:
    return _line(depth, f"</{tag}>")


def _leaf(depth: int, tag: str, text: str) -> str:
    """One element with its text. The caller escapes the text: only the name is free text."""
    return _line(depth, f"<{tag}>{text}</{tag}>")


def _number(value: float) -> str:
    """The shortest text that reads back as value, in plain decimal, never scientific notation."""
    text = repr(value)
    if "e" in text:
        text = format(Decimal(text), "f")
    return text


# --- the archive -------------------------------------------------------------------------


def _archive(members: Sequence[tuple[str, str]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(
        buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESSION_LEVEL
    ) as archive:
        for path, text in members:
            info = zipfile.ZipInfo(path, date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = ZIP_CREATE_SYSTEM
            info.external_attr = ZIP_ATTRIBUTES
            archive.writestr(
                info,
                text.encode("utf-8"),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=ZIP_COMPRESSION_LEVEL,
            )
    return buffer.getvalue()


# --- reading back ------------------------------------------------------------------------


def _members(kmz: bytes) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
            names = archive.namelist()
            if names != [TEMPLATE_PATH, WAYLINES_PATH]:
                raise ValueError(
                    f"a flight file holds {TEMPLATE_PATH} then {WAYLINES_PATH}, not {names}"
                )
            return {name: archive.read(name) for name in names}
    except zipfile.BadZipFile as error:
        raise ValueError(f"the flight file is not a KMZ: {error}") from error


def _parse(data: bytes) -> ET.Element:
    # ElementTree does not expose the parser's handlers, so a first pass with expat refuses
    # every declaration; only then does ElementTree build the tree.
    scanner = expat.ParserCreate()
    scanner.StartDoctypeDeclHandler = _refuse_doctype
    scanner.EntityDeclHandler = _refuse_entity
    try:
        scanner.Parse(data, True)
        # Safe to build: the scan above has refused every DOCTYPE and entity declaration.
        return ET.fromstring(data)  # noqa: S314
    except (expat.ExpatError, ET.ParseError) as error:
        raise ValueError(f"the flight file is not well-formed XML: {error}") from error


def _refuse_doctype(*_arguments: object) -> None:
    raise ValueError("the flight file declares a DOCTYPE, which is refused")


def _refuse_entity(*_arguments: object) -> None:
    raise ValueError("the flight file declares an entity, which is refused")


def _kml(tag: str) -> str:
    return f"{{{KML_NAMESPACE}}}{tag}"


def _wpml(tag: str) -> str:
    return f"{{{WPML_NAMESPACE}}}{tag}"


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def _only(parent: ET.Element, tag: str) -> ET.Element:
    found = parent.find(tag)
    if found is None:
        raise ValueError(f"{_local(parent.tag)} has no {_local(tag)}")
    return found


def _text(parent: ET.Element, tag: str) -> str:
    return _only(parent, tag).text or ""


def _reference_point(text: str) -> tuple[float, float]:
    """Latitude, longitude, height in the file; longitude, latitude as the bake holds them."""
    latitude, longitude, _height = _numbers(text, 3)
    return longitude, latitude


def _numbers(text: str, count: int) -> list[float]:
    parts = text.split(",")
    if len(parts) != count:
        raise ValueError(f"{text!r} should hold {count} comma-separated numbers")
    return [float(part) for part in parts]


def _read_placemark(placemark: ET.Element) -> dict[str, Any]:
    longitude, latitude = _numbers(_text(_only(placemark, _kml("Point")), _kml("coordinates")), 2)
    return {
        "index": int(_text(placemark, _wpml("index"))),
        "position": [longitude, latitude],
        "height_m": float(_text(placemark, _wpml("executeHeight"))),
    }
