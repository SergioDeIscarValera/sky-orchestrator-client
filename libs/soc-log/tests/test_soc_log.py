from __future__ import annotations

import asyncio
import io
import json
import logging
import sys
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import structlog

import soc_log

Lines = Callable[[], list[dict[str, Any]]]
MADE_AT_IMPORT = soc_log.get("made_at_import")


@pytest.fixture
def configured() -> Iterator[Callable[..., Lines]]:
    excepthook = sys.excepthook
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level

    def configure(level: str = "info") -> Lines:
        stream = io.BytesIO()
        soc_log.configure("soc-test", level=level, stream=stream)
        return lambda: [json.loads(line) for line in stream.getvalue().splitlines()]

    yield configure
    structlog.reset_defaults()
    structlog.contextvars.clear_contextvars()
    sys.excepthook = excepthook
    root.handlers[:] = handlers
    root.setLevel(level)
    logging.captureWarnings(False)


@pytest.fixture
def lines(configured: Callable[..., Lines]) -> Lines:
    return configured()


def test_a_line_leads_with_time_level_service_logger_and_event(lines: Lines) -> None:
    soc_log.get("soc_cloud.link").info("link_up", stack="lab")
    (line,) = lines()
    assert list(line)[:5] == ["time", "level", "service", "logger", "event"]
    assert line["level"] == "info"
    assert line["service"] == "soc-test"
    assert line["logger"] == "soc_cloud.link"
    assert line["event"] == "link_up"
    assert line["stack"] == "lab"


def test_a_logger_made_before_configure_writes_where_configure_said(lines: Lines) -> None:
    MADE_AT_IMPORT.info("late")
    assert lines()[0]["logger"] == "made_at_import"


def test_the_time_is_utc(lines: Lines) -> None:
    soc_log.get("t").info("tick")
    stamp = lines()[0]["time"]
    assert stamp.endswith("Z")
    written = datetime.fromisoformat(stamp)
    assert written.tzinfo is not None
    assert abs((datetime.now(UTC) - written).total_seconds()) < 5


def test_values_json_lacks_are_written_as_text(lines: Lines) -> None:
    identifier = uuid.UUID(int=7)
    soc_log.get("t").info(
        "written", flight=identifier, file=Path("/srv/f.kmz"), error=KeyError("x")
    )
    line = lines()[0]
    assert line["flight"] == str(identifier)
    assert line["file"] == "/srv/f.kmz"
    assert line["error"] == "'x'"


def test_correlation_identifiers_hold_for_the_block_only(lines: Lines) -> None:
    log = soc_log.get("t")
    with soc_log.correlated(organization="org-1", flight=uuid.UUID(int=1), tid=None):
        log.info("inside")
        with soc_log.correlated(command="cmd-9"):
            log.info("nested")
        log.info("after_nested")
    log.info("outside")
    inside, nested, after_nested, outside = lines()
    assert inside["organization"] == "org-1"
    assert inside["flight"] == str(uuid.UUID(int=1))
    assert "tid" not in inside
    assert nested["command"] == "cmd-9"
    assert nested["organization"] == "org-1"
    assert "command" not in after_nested
    assert not set(soc_log.CORRELATION) & outside.keys()


def test_an_unknown_correlation_identifier_is_refused(lines: Lines) -> None:
    with pytest.raises(ValueError, match="flight_id"), soc_log.correlated(flight_id="x"):
        pass


async def test_each_task_keeps_its_own_identifiers(lines: Lines) -> None:
    log = soc_log.get("t")

    async def fly(flight: str) -> None:
        with soc_log.correlated(flight=flight):
            for step in range(3):
                log.info("step", step=step)
                await asyncio.sleep(0)

    await asyncio.gather(fly("a"), fly("b"))
    written = lines()
    assert len(written) == 6
    assert {line["flight"] for line in written} == {"a", "b"}
    for flight in ("a", "b"):
        assert [line["step"] for line in written if line["flight"] == flight] == [0, 1, 2]


def test_lines_below_the_level_are_dropped(configured: Callable[..., Lines]) -> None:
    quiet = configured("warning")
    soc_log.get("t").info("dropped")
    soc_log.get("t").warning("kept")
    assert [line["event"] for line in quiet()] == ["kept"]


def test_debug_is_written_when_asked_for(configured: Callable[..., Lines]) -> None:
    verbose = configured("debug")
    soc_log.get("t").debug("detail")
    assert verbose()[0]["level"] == "debug"


def test_an_unknown_level_is_refused() -> None:
    with pytest.raises(ValueError, match="level"):
        soc_log.configure("soc-test", level="verbose")


def test_standard_logging_becomes_lines_of_the_same_shape(lines: Lines) -> None:
    with soc_log.correlated(stack="lab"):
        logging.getLogger("asyncpg.pool").warning("connection %s lost", 3)
    logging.getLogger("aiohttp.access").debug("dropped below the level")
    (line,) = lines()
    assert line["logger"] == "asyncpg.pool"
    assert line["level"] == "warning"
    assert line["event"] == "connection 3 lost"
    assert line["stack"] == "lab"


def test_an_exception_is_written_with_its_traceback(lines: Lines) -> None:
    try:
        raise RuntimeError("broker refused")
    except RuntimeError:
        soc_log.get("t").exception("link_failed")
    line = lines()[0]
    assert line["level"] == "error"
    assert "RuntimeError: broker refused" in line["exception"]


def test_an_uncaught_exception_is_a_critical_line(lines: Lines) -> None:
    error = ValueError("nothing caught it")
    sys.excepthook(ValueError, error, None)
    line = lines()[0]
    assert line["level"] == "critical"
    assert line["event"] == "uncaught_exception"
    assert "ValueError: nothing caught it" in line["exception"]


def test_asyncio_errors_are_lines(lines: Lines) -> None:
    loop = asyncio.new_event_loop()
    try:
        soc_log.asyncio_exception_handler(
            loop, {"message": "Task exception was never retrieved", "exception": OSError("gone")}
        )
        soc_log.asyncio_exception_handler(loop, {"message": "Unclosed client session"})
    finally:
        loop.close()
    with_error, without = lines()
    assert with_error["detail"] == "Task exception was never retrieved"
    assert "OSError: gone" in with_error["exception"]
    assert "exception" not in without
