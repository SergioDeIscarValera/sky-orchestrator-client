"""soc-operations' reads and writes: an operation's snapshot in, a decision's actions out.

Everything soc-operations knows of an operation is read here, in one transaction, and every
decision of soc_operations.lifecycle is applied here, in the transaction it was read in: a
move through soc.move_operation, which logs it; a flight file built and its dry run asked;
a flight and its prepare; a command; a flight ended; an event logged. The database's own
rules (migration 0010) refuse anything the lifecycle does not allow, so a bug here fails
loudly instead of moving an operation wrongly.

soc-operations runs one instance, and its runner applies one decision at a time, so two
decisions never race over one operation.
"""

from __future__ import annotations

import json
import secrets
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from soc_operations import flight_files
from soc_operations.lifecycle import (
    OUTCOME_UNKNOWN,
    Action,
    BuildFile,
    Command,
    EndFlight,
    Executed,
    File,
    Flight,
    FlightState,
    Log,
    Move,
    PrepareFlight,
    Snapshot,
)
from soc_operations.validation import (
    AssignmentView,
    FleetView,
    GeofenceView,
    OperationView,
    WaylineView,
)

SOURCE = "soc-operations"
#: The operations soc-operations watches: not drafts, not closed.
ACTIVE = (
    "planned", "preparing", "simulating", "simulated", "ready", "launching", "in_flight",
    "paused", "returning",
)  # fmt: skip


@dataclass(frozen=True)
class Stack:
    """The assigned fleet's stack, as soc-cloud last recorded it (IR-STK)."""

    gateway_sn: str
    link_state: str
    status: Mapping[str, Any] | None
    status_read_at: datetime | None
    envelope: Mapping[str, Any] | None
    envelope_read_at: datetime | None
    flight_files_url: str | None


@dataclass(frozen=True)
class Aircraft:
    """The assigned fleet's aircraft: its presence and latest sample (IR-DEV, IR-SMP)."""

    aircraft_sn: str
    online: bool | None
    sample: Mapping[str, Any] | None
    received_at: datetime | None


@dataclass(frozen=True)
class DryRun:
    status: str
    verdict: Mapping[str, Any] | None


@dataclass(frozen=True)
class Loaded:
    """An operation as soc-operations decides on it, and what its checks are judged on."""

    snapshot: Snapshot
    organization_id: uuid.UUID
    assignment_id: uuid.UUID | None
    fleet_id: uuid.UUID | None
    stack: Stack | None
    aircraft: Aircraft | None
    dry_run: DryRun | None
    #: Whether the stack has an unended flight of another operation (PF-IDLE).
    stack_busy: bool | None


def _json(value: Any) -> Any:
    """asyncpg hands jsonb as text."""
    return None if value is None else json.loads(value)


async def load(connection: asyncpg.Connection, operation_id: uuid.UUID) -> Loaded | None:
    """The operation's snapshot and its checks' inputs, or None when it does not exist."""
    row = await connection.fetchrow(
        """
        select o.id, o.organization_id, o.state::text as state, o.name,
               o.takeoff_security_height_m, g.polygon, g.max_height_m,
               g.deleted_at is not null as geofence_retired
          from soc.operations o left join soc.geofences g on g.id = o.geofence_id
         where o.id = $1
        """,
        operation_id,
    )
    if row is None:
        return None
    assigned = await connection.fetch(
        """
        select a.id, a.speed_ms, a.flight, w.name as wayline_name, w.takeoff, w.waypoints,
               w.deleted_at is not null as wayline_retired, f.id as fleet_id,
               f.name as fleet_name, f.deleted_at is not null as fleet_retired,
               f.gateway_sn, f.aircraft_sn
          from soc.assignments a
          join soc.waylines w on w.id = a.wayline_id
          join soc.fleets f on f.id = a.fleet_id
         where a.operation_id = $1
         order by a.created_at
        """,
        operation_id,
    )
    pilots = await connection.fetchval("select soc.commanding_pilots($1)", operation_id)
    geofence = (
        None
        if row["polygon"] is None
        else GeofenceView(
            polygon=_json(row["polygon"]),
            max_height_m=float(row["max_height_m"]),
            retired=row["geofence_retired"],
        )
    )
    assignments = [
        AssignmentView(
            speed_ms=None if each["speed_ms"] is None else float(each["speed_ms"]),
            flight=_json(each["flight"]),
            wayline=WaylineView(
                name=each["wayline_name"],
                takeoff=_json(each["takeoff"]),
                waypoints=_json(each["waypoints"]),
                retired=each["wayline_retired"],
            ),
            fleet=FleetView(name=each["fleet_name"], retired=each["fleet_retired"]),
        )
        for each in assigned
    ]
    view = OperationView(
        name=row["name"],
        takeoff_security_height_m=(
            None
            if row["takeoff_security_height_m"] is None
            else float(row["takeoff_security_height_m"])
        ),
        geofence=geofence,
        assignments=assignments,
        pilots=int(pilots),
    )
    first = assigned[0] if assigned else None
    stack = None if first is None else await _stack(connection, first["gateway_sn"])
    aircraft = (
        None
        if first is None
        else await _aircraft(connection, first["gateway_sn"], first["aircraft_sn"])
    )
    file = await _file(connection, operation_id)
    dry_run = None
    if file is not None and first is not None:
        ran = await connection.fetchrow(
            "select status::text as status, verdict from soc.dry_runs"
            " where file_id = $1 and gateway_sn = $2 order by requested_at desc limit 1",
            file.id, first["gateway_sn"],
        )  # fmt: skip
        if ran is not None:
            dry_run = DryRun(ran["status"], _json(ran["verdict"]))
    busy = None
    if first is not None:
        busy = await connection.fetchval(
            "select exists (select 1 from soc.flights"
            " where gateway_sn = $1 and ended_at is null and operation_id <> $2)",
            first["gateway_sn"], operation_id,
        )  # fmt: skip
    # A stop is its flight's: a launch in the simulator stopped says nothing of the next one.
    stopped = await connection.fetchval(
        "select exists (select 1 from soc.transition_requests r"
        " where r.operation_id = $1 and r.transition = 'stop' and r.status = 'accepted'"
        " and r.decided_at >= (select max(f.prepared_at) from soc.flights f"
        " where f.operation_id = $1))",
        operation_id,
    )
    snapshot = Snapshot(
        operation_id=operation_id,
        state=row["state"],
        view=view,
        status=None if stack is None else stack.status,
        envelope=None if stack is None else stack.envelope,
        flight_files_url=None if stack is None else stack.flight_files_url,
        file=file,
        flights=await _flights(connection, operation_id),
        stopped=bool(stopped),
    )
    return Loaded(
        snapshot=snapshot,
        organization_id=row["organization_id"],
        assignment_id=None if first is None else first["id"],
        fleet_id=None if first is None else first["fleet_id"],
        stack=stack,
        aircraft=aircraft,
        dry_run=dry_run,
        stack_busy=busy,
    )


async def _stack(connection: asyncpg.Connection, gateway: str) -> Stack | None:
    row = await connection.fetchrow(
        "select link_state::text as link_state, status, status_read_at, envelope,"
        " envelope_read_at, flight_files_url from soc.stacks where gateway_sn = $1",
        gateway,
    )
    if row is None:
        return None
    return Stack(
        gateway_sn=gateway,
        link_state=row["link_state"],
        status=_json(row["status"]),
        status_read_at=row["status_read_at"],
        envelope=_json(row["envelope"]),
        envelope_read_at=row["envelope_read_at"],
        flight_files_url=row["flight_files_url"],
    )


async def _aircraft(connection: asyncpg.Connection, gateway: str, aircraft: str) -> Aircraft:
    online = await connection.fetchval(
        "select online from soc.devices where gateway_sn = $1 and aircraft_sn = $2",
        gateway,
        aircraft,
    )
    latest = await connection.fetchrow(
        "select sample, received_at from soc.aircraft_samples where aircraft_sn = $1", aircraft
    )
    return Aircraft(
        aircraft_sn=aircraft,
        online=online,
        sample=None if latest is None else _json(latest["sample"]),
        received_at=None if latest is None else latest["received_at"],
    )


async def _file(connection: asyncpg.Connection, operation_id: uuid.UUID) -> File | None:
    row = await connection.fetchrow(
        "select id, md5, token from soc.flight_files where operation_id = $1"
        " order by created_at desc limit 1",
        operation_id,
    )
    return None if row is None else File(row["id"], row["md5"], row["token"])


async def _flights(connection: asyncpg.Connection, operation_id: uuid.UUID) -> list[Flight]:
    rows = await connection.fetch(
        """
        select f.id, f.mode::text as mode, f.file_id, f.config_fingerprint,
               f.executed_at is not null as executed, f.took_off_at is not null as took_off,
               f.landed_at is not null as landed, f.ended_at is not null as ended,
               s.status::text as status, s.result, s.end_reason::text as end_reason,
               (select max(c.replied_at) from soc.command_intents c
                 where c.flight_id = f.id and c.verb = 'execute' and c.result = $2)
                 as outcome_unknown_since
          from soc.flights f left join soc.flight_states s on s.flight_id = f.id
         where f.operation_id = $1
         order by f.prepared_at desc
        """,
        operation_id,
        OUTCOME_UNKNOWN,
    )
    return [
        Flight(
            id=row["id"],
            mode=row["mode"],
            file_id=row["file_id"],
            config_fingerprint=row["config_fingerprint"],
            executed=row["executed"],
            took_off=row["took_off"],
            landed=row["landed"],
            ended=row["ended"],
            state=(
                None
                if row["status"] is None
                else FlightState(row["status"], row["result"], row["end_reason"])
            ),
            outcome_unknown_since=row["outcome_unknown_since"],
        )
        for row in rows
    ]


async def apply(
    connection: asyncpg.Connection,
    loaded: Loaded,
    actions: Sequence[Action],
    *,
    actor: uuid.UUID | None = None,
) -> None:
    """Apply a decision's actions, in order, in the caller's transaction."""
    operation = loaded.snapshot.operation_id
    for action in actions:
        match action:
            case Move(to=to, cause=cause, end_reason=reason):
                await connection.execute(
                    "select soc.move_operation($1, $2::soc.operation_state, $3,"
                    " $4::soc.event_source, $5, $6::soc.end_reason)",
                    operation, to, cause, SOURCE, actor, reason,
                )  # fmt: skip
            case BuildFile():
                await _build_file(connection, loaded)
            case PrepareFlight(mode=mode, payload=payload):
                await _prepare_flight(connection, loaded, mode, payload)
            case Command(verb=verb, flight_id=flight, payload=payload):
                await _command(connection, loaded, flight, verb, payload)
            case Executed(flight_id=flight):
                await connection.execute(
                    "update soc.flights set executed_at = now()"
                    " where id = $1 and executed_at is null",
                    flight,
                )
            case EndFlight(flight_id=flight, end_reason=reason):
                await _end_flight(connection, loaded, flight, reason)
            case Log(kind=kind, payload=payload):
                await connection.execute(
                    "select soc.log_event($1, $2, $3::soc.event_source, $4::jsonb)",
                    operation, kind, SOURCE, json.dumps(payload),
                )  # fmt: skip


async def _end_flight(
    connection: asyncpg.Connection, loaded: Loaded, flight: uuid.UUID, reason: str
) -> None:
    """The flight ended, and its end logged with how its task ended (FR-LOG-02)."""
    ended = await connection.fetchval(
        "update soc.flights set ended_at = now(), end_reason = $2::soc.end_reason"
        " where id = $1 and ended_at is null returning fleet_id",
        flight, reason,
    )  # fmt: skip
    if ended is None:
        return
    flown = next((each for each in loaded.snapshot.flights if each.id == flight), None)
    state = None if flown is None else flown.state
    await connection.execute(
        "select soc.log_event($1, 'flight_ended', 'soc-operations', $2::jsonb, null, $3, $4)",
        loaded.snapshot.operation_id,
        json.dumps({
            "status": None if state is None else state.status,
            "result": None if state is None else state.result,
            "end_reason": reason,
        }),
        flight, ended,
    )  # fmt: skip


async def _build_file(connection: asyncpg.Connection, loaded: Loaded) -> None:
    """The flight file of the assignment's flight, kept as built, and its dry run asked."""
    assignment = loaded.snapshot.view.assignments[0]
    assert assignment.flight is not None
    kmz = flight_files.build(assignment.flight, name=assignment.wayline.name)
    wayline_id = await connection.fetchval(
        "select wayline_id from soc.assignments where id = $1", loaded.assignment_id
    )
    file_id = await connection.fetchval(
        "insert into soc.flight_files (organization_id, operation_id, wayline_id, bytes, md5,"
        " size_bytes, profile_version, token) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        loaded.organization_id, loaded.snapshot.operation_id, wayline_id, kmz,
        flight_files.fingerprint(kmz), len(kmz), flight_files.PROFILE_VERSION,
        secrets.token_hex(16),
    )  # fmt: skip
    if loaded.stack is not None:
        await connection.execute(
            "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)",
            loaded.organization_id, file_id, loaded.stack.gateway_sn,
        )  # fmt: skip


async def _prepare_flight(
    connection: asyncpg.Connection, loaded: Loaded, mode: str, payload: Mapping[str, Any]
) -> None:
    """A flight of the current file, snapshotting what it flies under, and its prepare."""
    snapshot = loaded.snapshot
    geofence = snapshot.view.geofence
    assert snapshot.file is not None and geofence is not None and loaded.stack is not None
    assert loaded.aircraft is not None and snapshot.envelope is not None
    status = snapshot.status or {}
    flight = await connection.fetchval(
        "insert into soc.flights (organization_id, operation_id, assignment_id, fleet_id,"
        " gateway_sn, aircraft_sn, mode, file_id, geofence_snapshot, envelope_snapshot,"
        " config_fingerprint)"
        " values ($1, $2, $3, $4, $5, $6, $7::soc.flight_mode, $8, $9::jsonb, $10::jsonb, $11)"
        " returning id",
        loaded.organization_id, snapshot.operation_id, loaded.assignment_id, loaded.fleet_id,
        loaded.stack.gateway_sn, loaded.aircraft.aircraft_sn, mode, snapshot.file.id,
        json.dumps({"polygon": list(geofence.polygon), "max_height_m": geofence.max_height_m}),
        json.dumps(snapshot.envelope), status.get("config_fingerprint"),
    )  # fmt: skip
    await connection.execute(
        "select soc.log_event($1, 'flight_prepared', 'soc-operations', $2::jsonb, null, $3, $4)",
        snapshot.operation_id, json.dumps({"mode": mode, "md5": snapshot.file.md5}),
        flight, loaded.fleet_id,
    )  # fmt: skip
    await _command(connection, loaded, flight, "prepare", {"flight_id": str(flight), **payload})


async def _command(
    connection: asyncpg.Connection,
    loaded: Loaded,
    flight: uuid.UUID,
    verb: str,
    payload: Mapping[str, Any],
) -> None:
    gateway = await connection.fetchval("select gateway_sn from soc.flights where id = $1", flight)
    await connection.execute(
        "insert into soc.command_intents (client_request_id, organization_id, operation_id,"
        " flight_id, gateway_sn, verb, payload)"
        " values ($1, $2, $3, $4, $5, $6::soc.command_verb, $7::jsonb)",
        uuid.uuid4(), loaded.organization_id, loaded.snapshot.operation_id, flight, gateway,
        verb, json.dumps(dict(payload)),
    )  # fmt: skip


async def active(connection: asyncpg.Connection) -> list[uuid.UUID]:
    """Every operation soc-operations watches."""
    rows = await connection.fetch(
        "select id from soc.operations where state = any($1::soc.operation_state[])", list(ACTIVE)
    )
    return [row["id"] for row in rows]


async def operations_of(connection: asyncpg.Connection, channel: str, key: str) -> list[uuid.UUID]:
    """The active operations a notification on `channel` about `key` concerns."""
    query = {
        "soc_aircraft_samples": "select a.operation_id from soc.assignments a"
        " join soc.fleets f on f.id = a.fleet_id where f.aircraft_sn = $1",
        "soc_stack_views": "select a.operation_id from soc.assignments a"
        " join soc.fleets f on f.id = a.fleet_id where f.gateway_sn = $1",
        "soc_dry_run_results": "select f.operation_id from soc.dry_runs d"
        " join soc.flight_files f on f.id = d.file_id where d.id = $1::uuid",
        "soc_flight_progress": "select operation_id from soc.flights where id = $1::uuid",
        "soc_command_outcomes": "select operation_id from soc.command_intents where id = $1::uuid",
    }[channel]
    rows = await connection.fetch(
        f"select distinct o.id from soc.operations o where o.id in ({query})"  # noqa: S608 - fixed queries
        " and o.state = any($2::soc.operation_state[])",
        key, list(ACTIVE),
    )  # fmt: skip
    return [row["id"] for row in rows]
