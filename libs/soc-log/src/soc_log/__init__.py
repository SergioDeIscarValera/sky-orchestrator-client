"""JSON log lines, one object each, carrying the correlation identifiers in force.

    soc_log.configure("soc-cloud")
    log = soc_log.get(__name__)
    with soc_log.correlated(organization=org, flight=flight_id, tid=tid):
        log.info("command_sent", verb="pause")

Every line carries `time` (UTC), `level`, `service`, `logger` and `event`, and
whichever correlation identifiers are in force in the task that wrote it
(NFR-OBS-01). Records of the standard library's logging, uncaught exceptions and
asyncio's unhandled errors become lines of the same shape.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from types import TracebackType
from typing import Any, BinaryIO

import msgspec
import structlog
from structlog.typing import EventDict, FilteringBoundLogger, Processor, WrappedLogger

CORRELATION = ("organization", "operation", "flight", "command", "stack", "device", "tid", "bid")
LEADING = ("time", "level", "service", "logger", "event")
LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING}

_ENCODER = msgspec.json.Encoder(enc_hook=str)

__all__ = [
    "CORRELATION",
    "asyncio_exception_handler",
    "configure",
    "correlated",
    "get",
]


def get(name: str) -> FilteringBoundLogger:
    logger: FilteringBoundLogger = structlog.get_logger(logger_name=name)
    return logger


@contextmanager
def correlated(**identifiers: object) -> Iterator[None]:
    unknown = sorted(identifiers.keys() - set(CORRELATION))
    if unknown:
        raise ValueError(f"not correlation identifiers: {', '.join(unknown)}")
    bound = {key: str(value) for key, value in identifiers.items() if value is not None}
    with structlog.contextvars.bound_contextvars(**bound):
        yield


def configure(service: str, *, level: str = "info", stream: BinaryIO | None = None) -> None:
    if level not in LEVELS:
        raise ValueError(f"level must be one of {', '.join(LEVELS)}")
    threshold = LEVELS[level]
    processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="time"),
        _ServiceName(service),
        structlog.processors.format_exc_info,
        _render,
    ]
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(threshold),
        logger_factory=structlog.BytesLoggerFactory(stream or sys.stdout.buffer),
        cache_logger_on_first_use=True,
    )
    _route_standard_logging(threshold)
    sys.excepthook = _log_uncaught


def asyncio_exception_handler(_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    error = context.get("exception")
    get("asyncio").error(
        "asyncio_error",
        detail=context.get("message", ""),
        exc_info=(type(error), error, error.__traceback__) if error else None,
    )


class _ServiceName:
    def __init__(self, service: str) -> None:
        self.service = service

    def __call__(self, _: WrappedLogger, __: str, event: EventDict) -> EventDict:
        event["service"] = self.service
        return event


def _render(_: WrappedLogger, __: str, event: EventDict) -> bytes:
    event["logger"] = event.pop("logger_name", "")
    ordered = {key: event.pop(key) for key in LEADING if key in event}
    ordered.update(event)
    return _ENCODER.encode(ordered)


class _ToStructlog(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        get(record.name).log(record.levelno, record.getMessage(), exc_info=record.exc_info or None)


def _route_standard_logging(threshold: int) -> None:
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    root.addHandler(_ToStructlog())
    root.setLevel(threshold)
    logging.captureWarnings(True)


def _log_uncaught(
    kind: type[BaseException], error: BaseException, traceback: TracebackType | None
) -> None:
    get("uncaught").critical("uncaught_exception", exc_info=(kind, error, traceback))
