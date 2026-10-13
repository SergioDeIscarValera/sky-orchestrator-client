"""One flighttask_progress from the dock, decoded as sent (FR-LNK-07).

The dock publishes the event while a task is unfinished and once when it finishes. A field
the message lacks decodes to None, never to a default (FR-SAF-03). A value that arrives is
carried as sent: nothing here clamps a percent or checks it against the schema's range.
The link does not validate what the dock sends, so a message that is not JSON, has a field
of the wrong type, or is another event raises ValueError naming the problem.
"""

from __future__ import annotations

from enum import StrEnum

import msgspec

PROGRESS = "flighttask_progress"


class FlightStatus(StrEnum):
    """DJI's FlighttaskStatusEnum, as the vendored progress schema names it."""

    SENT = "sent"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    OK = "ok"
    FAILED = "failed"
    CANCELED = "canceled"
    REJECTED = "rejected"
    TIMEOUT = "timeout"
    PARTIALLY_DONE = "partially_done"


class BreakPoint(msgspec.Struct, frozen=True, kw_only=True):
    """Where a mission stopped on its own, and why (FR-FLT-12, DEP-05)."""

    index: int | None = None
    state: int | None = None
    progress: float | None = None
    wayline_id: int | None = None
    break_reason: int | None = None
    attitude_head: float | None = None


class FlightProgress(msgspec.Struct, frozen=True, kw_only=True):
    """One flighttask_progress, flattened. Every field the message lacks is None.

    `bid` and `flight_id` are both the flight's id (IR-FLT): the schema requires each,
    and both are carried so a caller can see if they ever disagree. `timestamp` is the
    dock's Unix milliseconds, for the staleness rule (FR-SAF-02).
    """

    bid: str | None = None
    timestamp: int | None = None
    gateway: str | None = None
    flight_id: str | None = None
    status: FlightStatus | None = None
    result: int | None = None
    percent: int | None = None
    current_waypoint_index: int | None = None
    media_count: int | None = None
    break_point: BreakPoint | None = None


class _Progress(msgspec.Struct, frozen=True):
    percent: int | None = None


class _Ext(msgspec.Struct, frozen=True):
    current_waypoint_index: int | None = None
    media_count: int | None = None
    flight_id: str | None = None
    break_point: BreakPoint | None = None


class _Output(msgspec.Struct, frozen=True):
    status: FlightStatus | None = None
    progress: _Progress | None = None
    ext: _Ext | None = None


class _Data(msgspec.Struct, frozen=True):
    result: int | None = None
    output: _Output | None = None


class _Message(msgspec.Struct, frozen=True):
    bid: str | None = None
    timestamp: int | None = None
    gateway: str | None = None
    method: str | None = None
    data: _Data | None = None


def decode_progress(raw: bytes) -> FlightProgress:
    """Decode one flighttask_progress message, or raise ValueError naming the problem."""
    try:
        message = msgspec.json.decode(raw, type=_Message)
    except msgspec.DecodeError as error:
        raise ValueError(f"malformed {PROGRESS} message: {error}") from error
    if message.method != PROGRESS:
        raise ValueError(f"not a {PROGRESS} message: method is {message.method!r}")
    return _flatten(message)


def _flatten(message: _Message) -> FlightProgress:
    data = message.data
    output = data.output if data is not None else None
    ext = output.ext if output is not None else None
    progress = output.progress if output is not None else None
    return FlightProgress(
        bid=message.bid,
        timestamp=message.timestamp,
        gateway=message.gateway,
        flight_id=ext.flight_id if ext is not None else None,
        status=output.status if output is not None else None,
        result=data.result if data is not None else None,
        percent=progress.percent if progress is not None else None,
        current_waypoint_index=ext.current_waypoint_index if ext is not None else None,
        media_count=ext.media_count if ext is not None else None,
        break_point=ext.break_point if ext is not None else None,
    )
