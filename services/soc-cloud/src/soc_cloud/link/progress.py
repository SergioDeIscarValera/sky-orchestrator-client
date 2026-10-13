"""One flighttask_progress from the dock, decoded as sent, and how its task ended (FR-LNK-07).

The dock publishes the event while a task is unfinished and once when it finishes. A field
the message lacks decodes to None, never to a default (FR-SAF-03): a progress with no status
is not terminal, and one with no result is not completed. A value that arrives is carried as
sent: nothing here clamps a percent or checks it against the schema's range. The link does
not validate what the dock sends, so a message that is not JSON, has a field of the wrong
type, or is another event raises ValueError naming the problem.

The end reason is read from the result code first, then from the status and the break reason
of a stop on the aircraft's own (see end_reason). Where the vendored contracts do not say what
a code means, its entry in END_RESULTS says so.
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


class EndReason(StrEnum):
    """IR-OPS's end_reason, with exactly its values; IR-FLT's end_reason takes the same.

    Two of them come from SOC's own commands and events rather than from a progress:
    operator_stop (FR-CMD-04) and geofence_breach (FR-SAF-01).
    """

    COMPLETED = "completed"
    OPERATOR_STOP = "operator_stop"
    OPERATOR_RETURN = "operator_return"
    GEOFENCE_BREACH = "geofence_breach"
    ENVELOPE_BREACH = "envelope_breach"
    LOW_BATTERY = "low_battery"
    LINK_LOST = "link_lost"
    PILOT_TAKEOVER = "pilot_takeover"
    AIRCRAFT_FAULT = "aircraft_fault"
    CANCELLED = "cancelled"


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


#: The statuses that end a task. The schema names DJI's enum without saying which of its values
#: end a task. sent, in_progress and paused do not: a paused flight resumes (FR-CMD-02). ok ends
#: it (a resumed flight ends ok, FR-CMD-02) and so does canceled (FR-CMD-05). failed, rejected,
#: timeout and partially_done are terminal by their names only; Sky Orchestrator must confirm.
TERMINAL: frozenset[FlightStatus] = frozenset(
    {
        FlightStatus.OK,
        FlightStatus.FAILED,
        FlightStatus.CANCELED,
        FlightStatus.REJECTED,
        FlightStatus.TIMEOUT,
        FlightStatus.PARTIALLY_DONE,
    }
)
# The envelope's result: 0 is success, anything else is one of DJI's error codes (dji-envelope).
SUCCESS = 0

#: Sky Orchestrator's end results, by the DJI `result` they arrive with. None means IR-OPS has
#: no end reason for the result. Each entry says where its meaning comes from.
END_RESULTS: dict[int, EndReason | None] = {
    # Documented: FR-CMD-03 ends the flight `canceled` with the operator's return as its end
    # reason, 322283, and the M4 session notes (dependencies.md) agree. It is the code of a
    # return home, so SOC's own return after a geofence breach (FR-SAF-01) ends with it too.
    # This table cannot tell the two apart: the caller must take the cause from the return
    # it sent.
    322283: EndReason.OPERATOR_RETURN,
    # UNCONFIRMED: the vendored contracts define none of the four codes below. FR-LNK-07 lists
    # the reasons envelope breach, low battery, link lost, pilot takeover, operator return,
    # other, and its acceptance lists the codes in that same order, so the pairing is by
    # position and not stated. Sky Orchestrator must confirm it.
    321514: EndReason.ENVELOPE_BREACH,
    321773: EndReason.LOW_BATTERY,
    321775: EndReason.LINK_LOST,
    322282: EndReason.PILOT_TAKEOVER,
    # UNCONFIRMED, as the four above. Paired with "other" in FR-LNK-07, which IR-OPS has no
    # value for: no end reason.
    321000: None,
}

#: DJI's FlighttaskBreakReasonEnum, for the reasons the vendored progress schema gives in words
#: (FR-FLT-12): why a mission stopped on its own. Kept apart from END_RESULTS: a break reason
#: and a result code are different number spaces, so one table would read a result 2 as an
#: aircraft fault. 0 (an operator's pause, which ends nothing), 1564 (the flight code's own
#: failsafe) and 65534 (the aircraft acting on its own) have no IR-OPS value and are left out.
BREAK_REASONS: dict[int, EndReason] = {
    514: EndReason.ENVELOPE_BREACH,
    773: EndReason.LOW_BATTERY,
    775: EndReason.LINK_LOST,
    1282: EndReason.PILOT_TAKEOVER,
    2: EndReason.AIRCRAFT_FAULT,
}


def end_reason(progress: FlightProgress) -> EndReason | None:
    """How the task ended, or None while it has not, or while no IR-OPS value says why.

    The first rule that applies decides: a result code the table names; a task that ended ok,
    completed only with result 0; the break reason of a stop on the aircraft's own; a canceled
    task with no such stop, which is the cancel FR-CMD-05 describes. Anything else that has
    ended is None rather than a guess. A missing status is not terminal, so it ends nothing.
    """
    if progress.status not in TERMINAL:
        return None
    if progress.result is not None and progress.result in END_RESULTS:
        return END_RESULTS[progress.result]
    if progress.status == FlightStatus.OK:
        return EndReason.COMPLETED if progress.result == SUCCESS else None
    reason = _by_break_reason(progress.break_point)
    if reason is not None:
        return reason
    if progress.status == FlightStatus.CANCELED:
        return EndReason.CANCELLED
    return None


def _by_break_reason(break_point: BreakPoint | None) -> EndReason | None:
    reason = break_point.break_reason if break_point is not None else None
    if reason is None or reason not in BREAK_REASONS:
        return None
    return BREAK_REASONS[reason]
