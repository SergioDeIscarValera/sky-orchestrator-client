from __future__ import annotations

import pytest

from soc_check import _bytes, _json_lines


@pytest.mark.parametrize(
    ("text", "expected"),
    [("37.86MiB", int(37.86 * 1024**2)), ("512KiB", 512 * 1024), ("1.5GiB", int(1.5 * 1024**3)),
     ("900kB", 900_000), ("12B", 12)],
)  # fmt: skip
def test_docker_sizes_are_read_in_bytes(text: str, expected: int) -> None:
    assert _bytes(text) == expected


def test_a_size_without_a_unit_is_refused() -> None:
    with pytest.raises(ValueError, match="not a size"):
        _bytes("37.86")


def test_only_json_lines_are_kept() -> None:
    text = 'Traceback...\n{"event": "a"}\nplain\n{"event": "b"}\n'
    assert _json_lines(text) == [{"event": "a"}, {"event": "b"}]
