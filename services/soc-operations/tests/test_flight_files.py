"""A wayline's flight file (FR-WAY-11, ADR-0008): what the builder writes, and what SO accepts.

The subset tests read Sky Orchestrator's page of accepted WPML,
contracts/sky-orchestrator/wpml/supported-subset.md, and hold the builder's output to its own
tables: every element written is a row of that page for its parent, every required row of a
parent written is written, and each value is one the page's Accepted column accepts.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest

from soc_operations import flight_files

REPOSITORY = Path(__file__).resolve().parents[3]
SUBSET = REPOSITORY / "contracts" / "sky-orchestrator" / "wpml" / "supported-subset.md"
TEMPLATE = flight_files.TEMPLATE_PATH
WAYLINES = flight_files.WAYLINES_PATH
KML = flight_files.KML_NAMESPACE
WPML = flight_files.WPML_NAMESPACE
NAME = "Route"

ROUTE: dict[str, Any] = {
    "schema_version": "1.0.0",
    "takeoff_security_height_m": 20.0,
    "reference_point": [-4.7245, 41.6523],
    "speed_ms": 5.0,
    "finish_action": "return_home",
    "waypoints": [
        {"index": 0, "position": [-4.7245, 41.65255], "height_m": 30.0},
        {"index": 1, "position": [-4.72405, 41.65255], "height_m": 30.0},
        {"index": 2, "position": [-4.72405, 41.6523], "height_m": 35.0},
        {"index": 3, "position": [-4.7243, 41.6523], "height_m": 30.0},
    ],
    "distance_m": 113.756227,
    "duration_s": 22.751,
    "violations": [],
}


def bake(**changes: Any) -> dict[str, Any]:
    return {**copy.deepcopy(ROUTE), **changes}


def varied() -> dict[str, Any]:
    """Speeds into two waypoints, finish_action land, fractional numbers."""
    baked = bake(finish_action="land", speed_ms=6.5, takeoff_security_height_m=25.5)
    baked["waypoints"][1]["speed_ms"] = 4.0
    baked["waypoints"][3]["speed_ms"] = 9.25
    return baked


SHAPES = [bake(), bake(finish_action="hold"), varied()]
SHAPE_IDS = ["route-return-home", "hold", "varied-land"]


def members(kmz: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def archive_of(parts: Mapping[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def parsed(baked: Mapping[str, Any], path: str) -> ET.Element:
    return ET.fromstring(members(flight_files.build(baked, name=NAME))[path])  # noqa: S314


def expected_fields(baked: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "reference_point": baked["reference_point"],
        "takeoff_security_height_m": baked["takeoff_security_height_m"],
        "speed_ms": baked["speed_ms"],
        "finish_action": baked["finish_action"],
        "waypoints": [
            {"index": w["index"], "position": w["position"], "height_m": w["height_m"]}
            for w in baked["waypoints"]
        ],
    }


# --- the round trip and where each value sits ---------------------------------------------


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
def test_read_gives_back_the_bake_fields(baked: dict[str, Any]) -> None:
    kmz = flight_files.build(baked, name=NAME)
    assert flight_files.read(kmz) == expected_fields(baked)


def test_the_reference_point_is_latitude_first_in_the_file_only() -> None:
    text = members(flight_files.build(bake(), name=NAME))[WAYLINES].decode()
    assert "<wpml:takeOffRefPoint>41.6523,-4.7245,0</wpml:takeOffRefPoint>" in text
    read_back = flight_files.read(flight_files.build(bake(), name=NAME))
    assert read_back["reference_point"] == [-4.7245, 41.6523]
    assert read_back["reference_point"] != [41.6523, -4.7245]


def test_coordinates_are_longitude_then_latitude_with_no_height() -> None:
    text = members(flight_files.build(bake(), name=NAME))[WAYLINES].decode()
    assert "<coordinates>-4.7245,41.65255</coordinates>" in text
    assert "<coordinates>-4.7245,41.65255,30.0</coordinates>" not in text


def test_the_wayline_speed_and_each_outgoing_speed_follow_the_convention() -> None:
    text = members(flight_files.build(varied(), name=NAME))[WAYLINES].decode()
    assert "<wpml:autoFlightSpeed>6.5</wpml:autoFlightSpeed>" in text
    # Placemark i carries the speed of the leg out of waypoint i: the next waypoint's speed_ms.
    speeds = re.findall(r"<wpml:waypointSpeed>([^<]+)</wpml:waypointSpeed>", text)
    assert speeds == ["4.0", "6.5", "9.25", "6.5"]


def test_the_transit_into_waypoint_zero_flies_at_the_wayline_speed() -> None:
    baked = bake()
    baked["waypoints"][0]["speed_ms"] = 5.0  # equal to the wayline's: carried, nothing dropped
    text = members(flight_files.build(baked, name=NAME))[WAYLINES].decode()
    assert "<wpml:autoFlightSpeed>5.0</wpml:autoFlightSpeed>" in text
    assert "<wpml:globalTransitionalSpeed>5.0</wpml:globalTransitionalSpeed>" in text
    assert flight_files.read(flight_files.build(baked, name=NAME)) == expected_fields(bake())


def test_a_different_speed_into_waypoint_zero_is_refused_not_dropped() -> None:
    baked = bake()
    baked["waypoints"][0]["speed_ms"] = 2.0
    with pytest.raises(ValueError, match=r"waypoint 0 speed_ms 2 differs from the wayline's 5"):
        flight_files.build(baked, name=NAME)


@pytest.mark.parametrize(
    ("finish_action", "dji"),
    [("return_home", "goHome"), ("hold", "noAction"), ("land", "autoLand")],
)
def test_each_finish_action_is_the_dji_finish_action(finish_action: str, dji: str) -> None:
    kmz = flight_files.build(bake(finish_action=finish_action), name=NAME)
    assert f"<wpml:finishAction>{dji}</wpml:finishAction>" in members(kmz)[WAYLINES].decode()
    assert flight_files.read(kmz)["finish_action"] == finish_action


@pytest.mark.parametrize(
    "position",
    [
        [1e-05, -2.5e-07],
        [179.99999999999997, -89.99999999999999],
        [1 / 3, -2 / 3],
        [0.1 + 0.2, 0.0],
    ],
)
def test_positions_read_back_exactly_and_never_in_scientific_notation(
    position: list[float],
) -> None:
    baked = bake()
    baked["waypoints"][0]["position"] = position
    kmz = flight_files.build(baked, name=NAME)
    assert flight_files.read(kmz)["waypoints"][0]["position"] == position
    text = members(kmz)[WAYLINES].decode()
    coordinates = re.search(r"<coordinates>([^<]+)</coordinates>", text)
    assert coordinates is not None
    assert "e" not in coordinates[1].lower()
    longitude, latitude = (float(part) for part in coordinates[1].split(","))
    assert (longitude, latitude) == tuple(position)


def test_a_tiny_height_is_written_in_plain_decimal_and_read_back() -> None:
    baked = bake()
    baked["waypoints"][1]["height_m"] = 1e-05
    kmz = flight_files.build(baked, name=NAME)
    assert "<wpml:executeHeight>0.00001</wpml:executeHeight>" in members(kmz)[WAYLINES].decode()
    assert flight_files.read(kmz)["waypoints"][1]["height_m"] == 1e-05


@pytest.mark.parametrize(
    "change",
    [
        lambda b: b.update(speed_ms=15.0),
        lambda b: b.update(takeoff_security_height_m=120.0),
        lambda b: b["waypoints"][1].update(height_m=120.0),
        lambda b: b["waypoints"][2].update(speed_ms=15.0),
    ],
)
def test_the_limits_themselves_are_accepted(change: Callable[[dict[str, Any]], object]) -> None:
    baked = bake()
    change(baked)
    assert flight_files.read(flight_files.build(baked, name=NAME)) == expected_fields(baked)


# --- determinism and the archive ------------------------------------------------------------


def test_the_same_bake_and_name_give_the_same_bytes() -> None:
    assert flight_files.build(bake(), name=NAME) == flight_files.build(bake(), name=NAME)


def test_the_name_changes_the_template_and_not_the_waylines() -> None:
    first = members(flight_files.build(bake(), name="Alpha"))
    second = members(flight_files.build(bake(), name="Beta"))
    assert first[WAYLINES] == second[WAYLINES]
    assert first[TEMPLATE] != second[TEMPLATE]


def test_the_archive_holds_the_two_files_in_order_with_fixed_metadata() -> None:
    kmz = flight_files.build(bake(), name=NAME)
    with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
        infos = archive.infolist()
        assert archive.comment == b""
    assert [info.filename for info in infos] == [TEMPLATE, WAYLINES]
    for info in infos:
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        assert info.compress_type == zipfile.ZIP_DEFLATED
        assert info.external_attr == 0o644 << 16
        assert info.create_system == 3
        assert info.comment == b""
        assert info.extra == b""
        assert info.flag_bits == 0


def test_each_entry_is_deflated_at_level_nine() -> None:
    kmz = flight_files.build(bake(), name=NAME)
    contents = members(kmz)
    with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
        infos = archive.infolist()
    for info in infos:
        start = info.header_offset
        name_length, extra_length = struct.unpack("<HH", kmz[start + 26 : start + 30])
        begin = start + 30 + name_length + extra_length
        stored = kmz[begin : begin + info.compress_size]
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        assert stored == compressor.compress(contents[info.filename]) + compressor.flush()


def test_the_fingerprint_is_the_md5_hex_digest_of_the_bytes() -> None:
    kmz = flight_files.build(bake(), name=NAME)
    expected = hashlib.md5(kmz, usedforsecurity=False).hexdigest()
    assert flight_files.fingerprint(kmz) == expected
    assert len(flight_files.fingerprint(kmz)) == 32
    assert flight_files.fingerprint(kmz) != flight_files.fingerprint(
        flight_files.build(bake(), name="Other")
    )


# --- refusals -------------------------------------------------------------------------------


REFUSALS: list[tuple[Callable[[dict[str, Any]], object], str]] = [
    (lambda b: b.update(waypoints=[]), r"the bake has no waypoint"),
    (lambda b: b["waypoints"][1].update(index=2), r"waypoint at position 1 has index 2"),
    (lambda b: b["waypoints"][0].update(index=1), r"waypoint at position 0 has index 1"),
    (lambda b: b["waypoints"][0].update(index=True), r"waypoint at position 0 has index True"),
    (
        lambda b: b["waypoints"][0].update(position=[-4.7, 41.6, 30.0]),
        r"waypoint 0 position \[-4.7, 41.6, 30.0\] is not two finite numbers",
    ),
    (
        lambda b: b["waypoints"][2].update(position=[181.0, 41.6]),
        r"waypoint 2 position \[181.0, 41.6\] is not two finite numbers in range",
    ),
    (
        lambda b: b["waypoints"][2].update(position=[-4.7, 91.0]),
        r"waypoint 2 position \[-4.7, 91.0\] is not two finite numbers in range",
    ),
    (
        lambda b: b["waypoints"][2].update(position=[float("nan"), 41.6]),
        r"waypoint 2 position \[nan, 41.6\] is not two finite numbers",
    ),
    (
        lambda b: b["waypoints"][1].update(height_m=0.0),
        r"waypoint 1 height_m 0.0 is not in \(0, 120\] m",
    ),
    (
        lambda b: b["waypoints"][1].update(height_m=120.5),
        r"waypoint 1 height_m 120.5 is not in \(0, 120\] m",
    ),
    (
        lambda b: b["waypoints"][1].update(height_m=float("inf")),
        r"waypoint 1 height_m inf is not in",
    ),
    (lambda b: b["waypoints"][1].update(height_m=True), r"waypoint 1 height_m True is not in"),
    (lambda b: b.update(speed_ms=0), r"speed_ms 0 is not in \(0, 15\] m/s"),
    (lambda b: b.update(speed_ms=15.5), r"speed_ms 15.5 is not in \(0, 15\] m/s"),
    (
        lambda b: b["waypoints"][3].update(speed_ms=16.0),
        r"waypoint 3 speed_ms 16.0 is not in \(0, 15\] m/s",
    ),
    (
        lambda b: b.update(takeoff_security_height_m=0.0),
        r"takeoff_security_height_m 0.0 is not in \(0, 120\] m",
    ),
    (
        lambda b: b.update(takeoff_security_height_m=121.0),
        r"takeoff_security_height_m 121.0 is not in \(0, 120\] m",
    ),
    (
        lambda b: b.update(reference_point=[-4.7]),
        r"reference_point \[-4.7\] is not two finite numbers",
    ),
    (
        lambda b: b.update(finish_action="crash"),
        r"finish_action 'crash' is not one of return_home, hold, land",
    ),
    (
        lambda b: b["waypoints"][2].update(actions=[{"type": "take_photo"}]),
        r"waypoint 2 has actions, which the flight file does not write yet \(FR-WAY-12\)",
    ),
    (
        lambda b: b.update(
            violations=[
                {"rule": "leg_too_long", "message": "...", "waypoint_index": 2},
                {"rule": "distance_too_long", "message": "..."},
            ]
        ),
        r"the bake breaks 2 rule\(s\), so it does not fly: leg_too_long at waypoint 2; "
        r"distance_too_long$",
    ),
    (lambda b: b.update(violations=None), r"violations is not a list"),
    (lambda b: b.pop("violations"), r"the bake has no violations"),
    (lambda b: b.pop("speed_ms"), r"the bake has no speed_ms"),
    (lambda b: b["waypoints"][1].pop("height_m"), r"waypoint 1 has no height_m"),
    (lambda b: b["waypoints"][1].pop("position"), r"waypoint 1 has no position"),
]


@pytest.mark.parametrize(("change", "message"), REFUSALS)
def test_a_bake_the_subset_cannot_fly_is_refused_naming_the_problem(
    change: Callable[[dict[str, Any]], object], message: str
) -> None:
    baked = bake()
    change(baked)
    with pytest.raises(ValueError, match=message):
        flight_files.build(baked, name=NAME)


def test_empty_actions_are_no_actions_and_are_accepted() -> None:
    baked = bake()
    baked["waypoints"][2]["actions"] = []
    assert flight_files.read(flight_files.build(baked, name=NAME)) == expected_fields(bake())


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("", "the wayline has no name"),
        ("   ", "the wayline has no name"),
        ("Bad\x07name", "a character XML cannot carry"),
        ("Carriage\rreturn", "a character XML cannot carry"),
    ],
)
def test_a_name_xml_cannot_carry_is_refused(name: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        flight_files.build(bake(), name=name)


def test_the_name_is_escaped_and_reads_back_as_it_was_given() -> None:
    name = "Ridge <A> & \"B\" 'C' ]]> end"
    kmz = flight_files.build(bake(), name=name)
    template = members(kmz)[TEMPLATE].decode()
    assert "<name>Ridge &lt;A&gt; &amp; \"B\" 'C' ]]&gt; end</name>" in template
    root = ET.fromstring(members(kmz)[TEMPLATE])  # noqa: S314
    name_element = root.find(f"{{{KML}}}Document/{{{KML}}}name")
    assert name_element is not None
    assert name_element.text == name


# --- reading back: what read refuses ---------------------------------------------------------


@pytest.mark.parametrize(
    "declaration",
    ['<!DOCTYPE kml [<!ENTITY x "y">]>', '<!DOCTYPE kml SYSTEM "file:///etc/passwd">'],
)
def test_read_refuses_a_doctype_and_the_entities_it_declares(declaration: str) -> None:
    waylines = members(flight_files.build(bake(), name=NAME))[WAYLINES].decode()
    doctored = waylines.replace("<kml", f"{declaration}\n<kml", 1)
    kmz = archive_of({TEMPLATE: b"<kml/>", WAYLINES: doctored.encode()})
    with pytest.raises(ValueError, match="DOCTYPE"):
        flight_files.read(kmz)


def test_read_refuses_an_entity_reference_it_cannot_resolve() -> None:
    waylines = members(flight_files.build(bake(), name=NAME))[WAYLINES].decode()
    doctored = waylines.replace("<wpml:waylineId>0", "<wpml:waylineId>&bomb;0", 1)
    with pytest.raises(ValueError, match="not well-formed XML"):
        flight_files.read(archive_of({TEMPLATE: b"<kml/>", WAYLINES: doctored.encode()}))


def test_read_refuses_what_is_not_a_kmz() -> None:
    with pytest.raises(ValueError, match="not a KMZ"):
        flight_files.read(b"not a zip")


def test_read_refuses_a_kmz_with_other_members() -> None:
    with pytest.raises(
        ValueError, match=re.escape("holds wpmz/template.kml then wpmz/waylines.wpml")
    ):
        flight_files.read(archive_of({WAYLINES: b"<kml/>"}))


def test_read_refuses_malformed_xml() -> None:
    with pytest.raises(ValueError, match="not well-formed XML"):
        flight_files.read(archive_of({TEMPLATE: b"<kml/>", WAYLINES: b"<kml><Document>"}))


# --- Sky Orchestrator's subset, read from its own page --------------------------------------

NUMBER = r"\d+(?:\.\d+)?"
ABOVE_AT_MOST = re.compile(rf"above ({NUMBER}), at most ({NUMBER})")
UP_TO = re.compile(rf"({NUMBER}) to ({NUMBER})")
TOKEN = re.compile(r"`([^`]+)`")
#: The root element: the page's `/kml` section describes it, and no table row does.
ROOT = "/kml"
#: What the page says the template file is read for, not a table row of its own.
PROSE_ONLY = {"/kml/Document/name", "/kml/Document/Folder/wpml:templateType"}


@dataclass(frozen=True)
class Row:
    required: str
    accepted: str


def subset_rows() -> dict[str, Row]:
    """The rows of the subset's `/kml/...` tables, keyed by the full path of each element."""
    rows: dict[str, Row] = {}
    section: str | None = None
    for line in SUBSET.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = None
        elif line.startswith("### "):
            heading = line[4:].strip().strip("`")
            section = heading if heading.startswith("/kml") else None
        elif section is not None and line.startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) == 4 and cells[0] != "Element" and set(cells[0]) != {"-"}:
                rows[f"{section}/{cells[0].strip('`')}"] = Row(cells[1], cells[2])
    return rows


def subset_sections() -> set[str]:
    """The paths of the page's `### /kml...` headings: the root element is one of them."""
    headings = SUBSET.read_text(encoding="utf-8").splitlines()
    return {line[4:].strip().strip("`") for line in headings if line.startswith("### ")}


def prose(heading: str) -> str:
    """The text of one `## ` section of the subset page, its line wrapping undone."""
    text = SUBSET.read_text(encoding="utf-8")
    body = text.split(f"## {heading}\n", 1)[1].split("\n## ", 1)[0]
    return " ".join(body.split())


def prefixed(tag: str) -> str:
    assert tag.startswith("{"), f"{tag} is in no namespace"
    namespace, _, local = tag[1:].partition("}")
    if namespace == WPML:
        return f"wpml:{local}"
    assert namespace == KML, f"{local} is in neither the WPML nor the KML namespace"
    return local


def element_paths(element: ET.Element, parent: str = "") -> Iterator[tuple[str, ET.Element]]:
    path = f"{parent}/{prefixed(element.tag)}"
    yield path, element
    for child in element:
        yield from element_paths(child, path)


def parent_of(path: str) -> str:
    return path.rsplit("/", 1)[0]


def numbers(path: str, value: str, count: int) -> list[float]:
    parts = value.split(",")
    assert len(parts) == count, f"{path}: {value!r} should hold {count} numbers"
    return [float(part) for part in parts]


def accepted_by_the_page(path: str, value: str, accepted: str) -> None:
    """Holds one value to the page's Accepted cell for its path, reading the cell's own wording."""
    if accepted.startswith("latitude,longitude,height"):
        latitude, longitude, _height = numbers(path, value, 3)
        assert -90 <= latitude <= 90 and -180 <= longitude <= 180, path
    elif accepted.startswith("longitude,latitude"):
        longitude, latitude = numbers(path, value, 2)
        assert -180 <= longitude <= 180 and -90 <= latitude <= 90, path
    elif accepted.startswith("0, 1, 2"):
        return  # held as a sequence in document order by the placemark test
    elif match := ABOVE_AT_MOST.search(accepted):
        assert float(match[1]) < float(value) <= float(match[2]), f"{path}: {value}"
    elif match := UP_TO.search(accepted):
        assert float(match[1]) <= float(value) <= float(match[2]), f"{path}: {value}"
    else:
        tokens = TOKEN.findall(accepted)
        assert tokens, f"{path}: the page's Accepted cell {accepted!r} is not one this test reads"
        assert value in tokens, f"{path}: {value!r} is not one of {tokens}"


def test_the_subset_tables_are_read_in_full() -> None:
    rows = subset_rows()
    assert len(rows) >= 70
    assert ROOT in subset_sections()
    for path in (
        "/kml/Document",
        "/kml/Document/wpml:missionConfig/wpml:takeOffRefPoint",
        "/kml/Document/Folder/Placemark",
        "/kml/Document/Folder/Placemark/Point/coordinates",
        "/kml/Document/Folder/Placemark/wpml:waypointHeadingParam/wpml:waypointHeadingMode",
        "/kml/Document/Folder/Placemark/wpml:waypointTurnParam/wpml:waypointTurnMode",
    ):
        assert path in rows, path


def test_the_page_names_the_two_things_read_from_the_template() -> None:
    which_file = prose("Which file")
    assert "its `wpml:templateType`, which must be `waypoint`" in which_file
    assert "its `Document/name`" in which_file


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
@pytest.mark.parametrize("path", [TEMPLATE, WAYLINES])
def test_every_element_written_is_a_row_of_the_page_for_its_parent(
    baked: dict[str, Any], path: str
) -> None:
    rows = subset_rows()
    for element_path, _ in element_paths(parsed(baked, path)):
        if element_path == ROOT:
            assert ROOT in subset_sections()
        elif element_path not in PROSE_ONLY:
            assert element_path in rows, f"{element_path} is not in the subset"


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
@pytest.mark.parametrize("path", [TEMPLATE, WAYLINES])
def test_every_required_row_under_a_written_parent_is_written(
    baked: dict[str, Any], path: str
) -> None:
    rows = subset_rows()
    written = {element_path for element_path, _ in element_paths(parsed(baked, path))}
    for parent in written:
        # The template is read for its templateType and name only: its Folder is not held to
        # the execution file's required rows.
        if path == TEMPLATE and parent == "/kml/Document/Folder":
            continue
        required = {
            row_path
            for row_path, row in rows.items()
            if parent_of(row_path) == parent and row.required.startswith("yes")
        }
        assert not required - written, f"{parent} lacks {sorted(required - written)}"


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
@pytest.mark.parametrize("path", [TEMPLATE, WAYLINES])
def test_every_value_written_is_one_the_page_accepts(baked: dict[str, Any], path: str) -> None:
    rows = subset_rows()
    for element_path, element in element_paths(parsed(baked, path)):
        if len(element) or element_path in PROSE_ONLY:
            continue
        value = element.text or ""
        if element_path == "/kml/Document/Folder/wpml:templateType":
            assert value == "waypoint"
            continue
        accepted_by_the_page(element_path, value, rows[element_path].accepted)


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
def test_the_placemarks_are_indexed_in_document_order(baked: dict[str, Any]) -> None:
    folder = parsed(baked, WAYLINES).find(f"{{{KML}}}Document/{{{KML}}}Folder")
    assert folder is not None
    indexes = []
    for placemark in folder.findall(f"{{{KML}}}Placemark"):
        index = placemark.find(f"{{{WPML}}}index")
        assert index is not None
        indexes.append(int(index.text or ""))
    assert indexes == list(range(len(baked["waypoints"])))


@pytest.mark.parametrize("baked", SHAPES, ids=SHAPE_IDS)
@pytest.mark.parametrize("path", [TEMPLATE, WAYLINES])
def test_no_element_carries_an_attribute(baked: dict[str, Any], path: str) -> None:
    for element_path, element in element_paths(parsed(baked, path)):
        assert element.attrib == {}, element_path


# --- the golden texts: the reference waylines, held byte for byte ---------------------------

# Each contract is named in full, as REPOSITORY / "contracts" / "<unit>": the change guard in
# tools/tests reads the contracts a lane test uses from those spellings.
GOLDEN = REPOSITORY / "contracts" / "flight-files"
ROUTE_EXAMPLE = REPOSITORY / "contracts" / "geometry" / "examples" / "design.route.json"
DESIGN_SCHEMA: dict[str, Any] = json.loads(
    (REPOSITORY / "contracts" / "geometry" / "design.schema.json").read_text(encoding="utf-8")
)
#: The bake's own definition, checked on its own: a golden bake must be a bake the schema allows.
BAKED_SCHEMA = jsonschema_rs.validator_for(
    {
        "$schema": DESIGN_SCHEMA["$schema"],
        "$id": DESIGN_SCHEMA["$id"],
        "$defs": DESIGN_SCHEMA["$defs"],
        "$ref": "#/$defs/baked",
    }
)
#: Each case's wayline name, as its golden template.kml carries it.
GOLDEN_NAMES = {
    "route-return-home": "Route return home",
    "six-waypoints-land": "Six waypoints land",
}
GOLDEN_FILES = ("bake.json", "template.kml", "waylines.wpml", "kmz.sha256")


def golden_bake(case: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((GOLDEN / case / "bake.json").read_text(encoding="utf-8"))
    return loaded


def golden_file(case: str, name: str) -> bytes:
    return (GOLDEN / case / name).read_bytes()


def test_the_golden_directories_are_exactly_the_cases_held() -> None:
    assert {path.name for path in GOLDEN.iterdir() if path.is_dir()} == set(GOLDEN_NAMES)


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_each_golden_case_holds_its_four_files(case: str) -> None:
    assert sorted(path.name for path in (GOLDEN / case).iterdir()) == sorted(GOLDEN_FILES)


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_the_builder_writes_the_golden_texts(case: str) -> None:
    written = members(flight_files.build(golden_bake(case), name=GOLDEN_NAMES[case]))
    assert written[TEMPLATE] == golden_file(case, "template.kml")
    assert written[WAYLINES] == golden_file(case, "waylines.wpml")


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_the_kmz_hashes_are_the_golden_hashes(case: str) -> None:
    kmz = flight_files.build(golden_bake(case), name=GOLDEN_NAMES[case])
    recorded = dict(
        line.split(": ", 1) for line in golden_file(case, "kmz.sha256").decode().splitlines()
    )
    assert recorded == {
        "sha256": hashlib.sha256(kmz).hexdigest(),
        "fingerprint_md5": flight_files.fingerprint(kmz),
    }


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_building_a_golden_case_twice_gives_identical_bytes(case: str) -> None:
    baked = golden_bake(case)
    assert flight_files.build(baked, name=GOLDEN_NAMES[case]) == flight_files.build(
        baked, name=GOLDEN_NAMES[case]
    )


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_each_golden_flight_file_reads_back_as_its_bake(case: str) -> None:
    baked = golden_bake(case)
    assert flight_files.read(flight_files.build(baked, name=GOLDEN_NAMES[case])) == (
        expected_fields(baked)
    )


@pytest.mark.parametrize("case", sorted(GOLDEN_NAMES))
def test_each_golden_bake_follows_the_baked_definition_of_the_design_schema(case: str) -> None:
    assert list(BAKED_SCHEMA.iter_errors(golden_bake(case))) == []


def test_the_route_case_is_the_route_examples_bake() -> None:
    example = json.loads(ROUTE_EXAMPLE.read_text(encoding="utf-8"))
    assert golden_bake("route-return-home") == example["baked"]


def test_the_six_waypoint_case_has_six_waypoints_speeds_into_two_and_lands() -> None:
    baked = golden_bake("six-waypoints-land")
    assert len(baked["waypoints"]) == 6
    assert [w["index"] for w in baked["waypoints"] if "speed_ms" in w] == [1, 3]
    assert baked["finish_action"] == "land"
