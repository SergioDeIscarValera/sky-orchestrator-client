from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Iterator

import pytest
import structlog

from soc_cloud.__main__ import CONFIGURATION_REFUSED, main


@pytest.fixture(autouse=True)
def restored_logging() -> Iterator[None]:
    excepthook = sys.excepthook
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield
    structlog.reset_defaults()
    sys.excepthook = excepthook
    root.handlers[:] = handlers
    root.setLevel(level)
    logging.captureWarnings(False)


def test_a_refused_configuration_stops_the_start_naming_every_problem(
    monkeypatch: pytest.MonkeyPatch, capsysbinary: pytest.CaptureFixture[bytes]
) -> None:
    for name in [name for name in os.environ if name.startswith("SOC_")]:
        monkeypatch.delenv(name)
    monkeypatch.setenv("SOC_DB_PORT", "not-a-port")

    assert main() == CONFIGURATION_REFUSED

    (line,) = [json.loads(text) for text in capsysbinary.readouterr().out.splitlines()]
    assert line["event"] == "configuration_refused"
    assert line["level"] == "critical"
    assert line["service"] == "soc-cloud"
    assert "SOC_CONFIG_FILE is not set" in line["problems"]
    assert "SOC_DB_PORT must be a port number" in line["problems"]
