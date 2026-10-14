"""The flights soc-cloud flies, and what each aircraft reports for them (M4; ADR-0010, ADR-0025).

Every aircraft sample is recorded as the aircraft's latest (soc.aircraft_samples), so
soc-operations judges the preflight checks on what the console shows. Writes are
coalesced: the latest per aircraft waits, a newer one replaces it, and a database that is
away loses nothing but the samples in between.

A flight is watched from its prepare, when its file is kept in memory for the dock to
download (ADR-0008), until soc-operations ends it; every connection, and every
`RECONCILE_S`, reads the flights not ended yet, so a restart watches what it watched before
and a flight soc-operations ended stops being watched and served. While a flight executes,
from its execute accepted or its first progress in flight:

- every sample is judged against the flight's geofence snapshot (soc_geo.fence). The first
  one outside sends return_home on the wire at once, before anything is written, then
  records it with the breach (FR-SAF-01). Once per flight: the flight keeps when it was
  breached, so a restart never sends it twice. A send that fails is tried again with the
  next sample outside. A sample entering the warning band logs a warning;
- the track keeps the first sample of each second (FR-TEL-04, IR-TEL-01), written in one
  insert every `telemetry_batch_s`. A sample without a position or a height is not kept:
  nothing is filled in (FR-SAF-03);
- take-off, landing and the aircraft's own return home are read from its flight mode
  (FR-LOG-02): a take-off is its first mode in the air, a landing its first mode on the
  ground after one, a return its entering mode 9 from another mode it was seen in;
- no sample for `telemetry_stale_after_ms` raises one safety event and no command, since
  link loss is the device's policy (FR-SAF-06); a sample after it says it is fresh again.
  A flight on the ground after its task ended is not watched for it.

The task's progress (FR-LNK-07) is recorded with how it ended; the database names a return
that soc-cloud sent for a breach as the breach. The fleet's aircraft going offline or online
is logged in the operation of each flight watched for it.

Records are written in the order they happened, each once: one the database is away or busy
for is tried again, in its place, and one it refuses is logged and dropped.
"""

from __future__ import annotations

import asyncio
import functools
import json
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NamedTuple, Protocol

import asyncpg

import soc_log
from soc_cloud.commands import Intent
from soc_cloud.fanout import payload as broadcast
from soc_cloud.files import FlightFileConflictError, FlightFiles
from soc_cloud.latency import Latencies
from soc_cloud.link.progress import TERMINAL, FlightProgress, FlightStatus, end_reason
from soc_cloud.link.telemetry import Sample
from soc_cloud.stacks import RETRY_S, TRANSIENT
from soc_db import Database
from soc_geo.fence import Geofence, Judgement, Verdict, geofence_of, judge
from soc_geo.projection import Geodetic

#: DJI's flight modes on the ground (mode_code): standby, preparing to take off, ready to
#: take off.
ON_THE_GROUND = frozenset({0, 1, 2})
#: Modes that do not say where the aircraft is: upgrading, not connected.
NOT_KNOWN = frozenset({13, 14})
#: DJI's automatic return to home.
RETURNING = 9
#: A task in flight: the dock executes it.
FLYING = frozenset({FlightStatus.IN_PROGRESS, FlightStatus.PAUSED})
#: How often the flights not ended yet are read again.
RECONCILE_S = 5.0
#: How often the executing flights are checked for telemetry gone stale.
STALE_TICK_S = 0.1
#: The track keeps one sample of each such slot of the aircraft's clock (FR-TEL-04).
HISTORY_SLOT_MS = 1000

log = soc_log.get(__name__)


@dataclass(frozen=True)
class Flight:
    """A flight not ended yet, as soc.flights and soc.flight_states hold it."""

    id: uuid.UUID
    organization_id: uuid.UUID
    operation_id: uuid.UUID
    fleet_id: uuid.UUID
    gateway: str
    aircraft: str
    #: The geofence snapshot: {"polygon": [[longitude, latitude], ...], "max_height_m": m}.
    geofence: dict[str, Any]
    executing: bool = False
    took_off: bool = False
    landed: bool = False
    breached: bool = False
    terminal: bool = False


class TrackRow(NamedTuple):
    """One sample of a flight's track, in soc.telemetry_samples' TRACK_COLUMNS order."""

    flight_id: uuid.UUID
    sampled_at: datetime
    organization_id: uuid.UUID
    fleet_id: uuid.UUID
    received_at: datetime
    longitude: float
    latitude: float
    height_m: float
    heading_deg: float | None
    battery_pct: int | None
    satellites: int | None
    gps_quality: int | None
    mode_code: int | None
    home_distance_m: float | None


TRACK_COLUMNS = TrackRow._fields


class FlightStore(Protocol):
    async def unended(self) -> list[Flight]: ...

    async def flight(self, flight: uuid.UUID) -> Flight | None: ...

    async def file(self, flight: uuid.UUID) -> tuple[bytes, str] | None: ...

    async def record_latest(
        self, aircraft: str, gateway: str, sample: str, sampled_at: datetime
    ) -> None: ...

    async def record_progress(
        self,
        flight: uuid.UUID,
        status: str,
        result: int | None,
        percent: int | None,
        waypoint: int | None,
        break_point: str | None,
        ended: str | None,
    ) -> None: ...

    async def record_moment(
        self, flight: uuid.UUID, moment: str, at: datetime, mode: int
    ) -> None: ...

    async def record_breach(
        self, flight: uuid.UUID, intent: uuid.UUID, outside: str, sampled_at: datetime
    ) -> bool: ...

    async def log(
        self,
        operation: uuid.UUID,
        kind: str,
        payload: str,
        flight: uuid.UUID,
        fleet: uuid.UUID,
        at: datetime,
    ) -> None: ...

    async def record_track(self, rows: Sequence[TrackRow]) -> None: ...


class Returner(Protocol):
    """Puts soc-cloud's own return home on the wire; commands.Commands is one."""

    async def send_now(self, gateway: str, flight: uuid.UUID, verb: str) -> uuid.UUID | None: ...

    def recorded(self, intent: uuid.UUID, *, kept: bool) -> None: ...


# --- The database ------------------------------------------------------------------------

_FLIGHTS = """
select f.id, f.organization_id, f.operation_id, f.fleet_id, f.gateway_sn, f.aircraft_sn,
       f.geofence_snapshot,
       f.executed_at is not null or coalesce(s.status = any($1::soc.flight_status[]), false)
         as executing,
       f.took_off_at is not null as took_off,
       f.landed_at is not null as landed,
       f.breached_at is not null as breached,
       coalesce(s.status = any($2::soc.flight_status[]), false) as terminal
  from soc.flights f
  left join soc.flight_states s on s.flight_id = f.id
"""
UNENDED = _FLIGHTS + " where f.ended_at is null order by f.prepared_at"
ONE = _FLIGHTS + " where f.id = $3"
FILE = """
select l.bytes, l.token
  from soc.flights f
  join soc.flight_files l on l.id = f.file_id
 where f.id = $1
"""
# The columns in TrackRow's order, which a test holds.
TRACK = """
insert into soc.telemetry_samples (flight_id, sampled_at, organization_id, fleet_id, received_at,
  longitude, latitude, height_m, heading_deg, battery_pct, satellites, gps_quality, mode_code,
  home_distance_m)
select * from unnest(
  $1::uuid[], $2::timestamptz[], $3::uuid[], $4::uuid[], $5::timestamptz[],
  $6::float8[], $7::float8[], $8::real[], $9::real[], $10::smallint[], $11::smallint[],
  $12::smallint[], $13::smallint[], $14::real[]
)
on conflict do nothing
"""
# A closed operation's log takes nothing more: what soc-cloud saw after is not logged.
LOG = """
select soc.log_event($1, $2, 'soc-cloud', $3::jsonb, null, $4, $5, null, $6)
 where soc.is_open($1)
"""
_FLYING = [status.value for status in FLYING]
_TERMINAL = [status.value for status in TERMINAL]


class PostgresFlightStore:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def unended(self) -> list[Flight]:
        async with self._database.session() as connection:
            rows = await connection.fetch(UNENDED, _FLYING, _TERMINAL)
        return [_flight(row) for row in rows]

    async def flight(self, flight: uuid.UUID) -> Flight | None:
        async with self._database.session() as connection:
            row = await connection.fetchrow(ONE, _FLYING, _TERMINAL, flight)
        return None if row is None else _flight(row)

    async def file(self, flight: uuid.UUID) -> tuple[bytes, str] | None:
        async with self._database.session() as connection:
            row = await connection.fetchrow(FILE, flight)
        return None if row is None else (bytes(row["bytes"]), row["token"])

    async def record_latest(
        self, aircraft: str, gateway: str, sample: str, sampled_at: datetime
    ) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_aircraft_sample($1, $2, $3::jsonb, $4)",
                aircraft, gateway, sample, sampled_at,
            )  # fmt: skip

    async def record_progress(
        self,
        flight: uuid.UUID,
        status: str,
        result: int | None,
        percent: int | None,
        waypoint: int | None,
        break_point: str | None,
        ended: str | None,
    ) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_flight_progress("
                "$1, $2::soc.flight_status, $3, $4, $5, $6::jsonb, $7::soc.end_reason)",
                flight, status, result, percent, waypoint, break_point, ended,
            )  # fmt: skip

    async def record_moment(self, flight: uuid.UUID, moment: str, at: datetime, mode: int) -> None:
        async with self._database.session() as connection:
            await connection.execute(
                "select soc.record_flight_moment($1, $2, $3, $4)", flight, moment, at, mode
            )

    async def record_breach(
        self, flight: uuid.UUID, intent: uuid.UUID, outside: str, sampled_at: datetime
    ) -> bool:
        async with self._database.session() as connection:
            kept: bool = await connection.fetchval(
                "select soc.record_geofence_breach($1, $2, $3::jsonb, $4)",
                flight, intent, outside, sampled_at,
            )  # fmt: skip
        return kept

    async def log(
        self,
        operation: uuid.UUID,
        kind: str,
        payload: str,
        flight: uuid.UUID,
        fleet: uuid.UUID,
        at: datetime,
    ) -> None:
        async with self._database.session() as connection:
            await connection.execute(LOG, operation, kind, payload, flight, fleet, at)

    async def record_track(self, rows: Sequence[TrackRow]) -> None:
        columns = [list(column) for column in zip(*rows, strict=True)]
        async with self._database.session() as connection:
            await connection.execute(TRACK, *columns)


def _flight(row: asyncpg.Record) -> Flight:
    return Flight(
        id=row["id"],
        organization_id=row["organization_id"],
        operation_id=row["operation_id"],
        fleet_id=row["fleet_id"],
        gateway=row["gateway_sn"],
        aircraft=row["aircraft_sn"],
        geofence=json.loads(row["geofence_snapshot"]),
        executing=row["executing"],
        took_off=row["took_off"],
        landed=row["landed"],
        breached=row["breached"],
        terminal=row["terminal"],
    )


# --- The watch ---------------------------------------------------------------------------


@dataclass
class Watched:
    """A watched flight, and what soc-cloud has seen of it since."""

    flight: Flight
    fence: Geofence | None
    #: When it was watched, and when it began to execute, on the monotonic clock.
    added: float
    since: float
    executing: bool
    took_off: bool
    landed: bool
    breached: bool
    terminal: bool
    breaching: bool = False
    warned: bool = False
    mode: int | None = None
    last_received: float | None = None
    last_sampled_ms: int | None = None
    last_slot: int | None = None
    stale: bool = False

    @property
    def on_the_ground_for_good(self) -> bool:
        """Its task ended and it stands on the ground: landed, or it never took off."""
        return self.terminal and (self.landed or not self.took_off)


@dataclass(frozen=True)
class Latest:
    gateway: str
    sample: str
    sampled_at: datetime


@dataclass(frozen=True)
class Record:
    """One write of the journal: what it records, for which flight, and the write itself."""

    name: str
    flight: uuid.UUID
    write: Callable[[], Awaitable[object]]


class FlightWatch:
    def __init__(
        self,
        store: FlightStore,
        files: FlightFiles,
        returner: Returner,
        *,
        stale_after_ms: int,
        warning_band_m: float,
        batch_s: float,
        latencies: Latencies | None = None,
        retry_s: float = RETRY_S,
        reconcile_s: float = RECONCILE_S,
        stale_tick_s: float = STALE_TICK_S,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._files = files
        self._returner = returner
        self._stale_after_s = stale_after_ms / 1000
        self._warning_band_m = warning_band_m
        self._batch_s = batch_s
        self._latencies = latencies or Latencies()
        self._retry_s = retry_s
        self._reconcile_s = reconcile_s
        self._stale_tick_s = stale_tick_s
        self._clock = clock
        self._monotonic = monotonic
        self._flights: dict[uuid.UUID, Watched] = {}
        self._latest: dict[str, Latest] = {}
        self._latest_changed = asyncio.Event()
        self._journal: deque[Record] = deque()
        self._journal_ready = asyncio.Event()
        self._track: list[TrackRow] = []
        self._tasks: set[asyncio.Task[None]] = set()

    def watched(self, flight: uuid.UUID) -> Watched | None:
        return self._flights.get(flight)

    async def run(self) -> None:
        async with asyncio.TaskGroup() as group:
            group.create_task(self._write_journal())
            group.create_task(self._write_latest())
            group.create_task(self._write_track())
            group.create_task(self._watch_staleness())
            group.create_task(self._reconcile())

    # --- What the commands report ----------------------------------------------------------

    async def preparing(self, intent: Intent) -> bool:
        """Keeps the file of the flight a prepare is about to name, and watches the flight.

        False when the flight or its file is not there, or its file cannot be served: the
        prepare must not go out. The database being away raises, so the prepare waits.
        """
        flight = await self._store.flight(intent.flight_id)
        file = await self._store.file(intent.flight_id)
        if flight is None or file is None:
            log.error("flight_file_not_found", flight=str(intent.flight_id))
            return False
        if not self._keep(flight.id, *file):
            return False
        self._watch(flight)
        return True

    def settled(self, intent: Intent, result: int) -> None:
        """An execute the dock accepted: its flight executes from now."""
        if intent.verb != "execute" or result != 0:
            return
        watched = self._flights.get(intent.flight_id)
        if watched is not None:
            self._executes(watched)

    # --- What the links report ----------------------------------------------------------

    def sampled(self, sample: Sample) -> None:
        received = self._clock()
        sampled_at = _at(sample.taken_at_ms)
        self._latest[sample.aircraft] = Latest(
            sample.gateway,
            json.dumps(broadcast(sample, round(received * 1000))),
            sampled_at,
        )
        self._latest_changed.set()
        for watched in self._flights_of(sample.aircraft):
            self._heard(watched, sample, sampled_at, received)

    def progressed(self, progress: FlightProgress) -> None:
        flight = _flight_of(progress)
        if flight is None or progress.status is None:
            log.warning(
                "flight_progress_unusable",
                bid=progress.bid,
                flight_id=progress.flight_id,
                status=progress.status,
            )
            return
        watched = self._flights.get(flight)
        if watched is not None:
            if progress.status in FLYING:
                self._executes(watched)
            if progress.status in TERMINAL:
                watched.terminal = True
        reason = end_reason(progress)
        break_point = progress.break_point
        self._record(
            "flight_progress",
            flight,
            functools.partial(
                self._store.record_progress,
                flight,
                progress.status.value,
                progress.result,
                progress.percent,
                progress.current_waypoint_index,
                None if break_point is None else _json(break_point),
                None if reason is None else reason.value,
            ),
        )

    def presence(self, aircraft: str, online: bool) -> None:
        """The fleet's aircraft went online or offline: logged in each flight watched for it."""
        kind = "fleet_online" if online else "fleet_offline"
        for watched in self._flights_of(aircraft):
            self._log(watched, kind, {"aircraft_sn": aircraft}, _at(round(self._clock() * 1000)))

    # --- The flights watched ------------------------------------------------------------

    async def sweep(self) -> None:
        """Watches every flight not ended yet; stops watching those soc-operations ended."""
        started = self._monotonic()
        flights = await self._store.unended()
        for flight in flights:
            if flight.id in self._flights:
                continue
            file = await self._store.file(flight.id)
            if file is not None:
                self._keep(flight.id, *file)
            self._watch(flight)
        unended = {flight.id for flight in flights}
        for flight_id, watched in list(self._flights.items()):
            # One watched after the read started may be newer than what it read.
            if flight_id not in unended and watched.added < started:
                self._finish(flight_id)

    def _keep(self, flight: uuid.UUID, content: bytes, token: str) -> bool:
        try:
            self._files.keep(str(flight), content, token)
        except (FlightFileConflictError, ValueError) as error:
            log.error("flight_file_not_kept", flight=str(flight), error=str(error))
            return False
        return True

    def _watch(self, flight: Flight) -> None:
        if flight.id in self._flights:
            return
        now = self._monotonic()
        self._flights[flight.id] = Watched(
            flight=flight,
            fence=_fence(flight),
            added=now,
            since=now,
            executing=flight.executing,
            took_off=flight.took_off,
            landed=flight.landed,
            breached=flight.breached,
            terminal=flight.terminal,
        )
        log.info("flight_watched", flight=str(flight.id), executing=flight.executing)

    def _finish(self, flight: uuid.UUID) -> None:
        self._flights.pop(flight, None)
        self._files.finished(str(flight))
        log.info("flight_watch_ended", flight=str(flight))

    def _executes(self, watched: Watched) -> None:
        if watched.executing:
            return
        watched.executing = True
        watched.since = self._monotonic()
        log.info("flight_executing", flight=str(watched.flight.id))

    def _flights_of(self, aircraft: str) -> list[Watched]:
        return [each for each in self._flights.values() if each.flight.aircraft == aircraft]

    # --- One sample of a watched flight -------------------------------------------------

    def _heard(
        self, watched: Watched, sample: Sample, sampled_at: datetime, received: float
    ) -> None:
        heard = self._monotonic()
        watched.last_received = heard
        watched.last_sampled_ms = sample.taken_at_ms
        if watched.stale:
            watched.stale = False
            self._log(
                watched, "telemetry_fresh", {"sampled_at": sampled_at.isoformat()}, sampled_at
            )
            log.info("telemetry_fresh", flight=str(watched.flight.id))
        if not watched.executing:
            return
        self._judge(watched, sample, sampled_at, heard)
        self._moments(watched, sample, sampled_at)
        self._keep_in_track(watched, sample, sampled_at, received)

    def _judge(self, watched: Watched, sample: Sample, sampled_at: datetime, heard: float) -> None:
        if watched.fence is None or watched.breached or watched.breaching:
            return
        position = _position(sample)
        judgement = judge(watched.fence, position, sample.height_m, self._warning_band_m)
        match judgement.verdict:
            case Verdict.OUTSIDE:
                watched.breaching = True
                self._spawn(self._return_home(watched, sample, sampled_at, judgement, heard))
            case Verdict.WARNING:
                if not watched.warned:
                    watched.warned = True
                    self._log(
                        watched,
                        "geofence_warning",
                        {
                            "position": _lonlat(sample),
                            "height_m": sample.height_m,
                            "distance_to_boundary_m": judgement.distance_to_boundary_m,
                        },
                        sampled_at,
                    )
            case Verdict.INSIDE:
                watched.warned = False
            case Verdict.UNKNOWN:
                pass

    async def _return_home(
        self,
        watched: Watched,
        sample: Sample,
        sampled_at: datetime,
        judgement: Judgement,
        heard: float,
    ) -> None:
        flight = watched.flight
        try:
            intent = await self._returner.send_now(flight.gateway, flight.id, "return_home")
        finally:
            watched.breaching = False
        if intent is None:
            log.error("geofence_return_not_sent", flight=str(flight.id))
            return
        watched.breached = True
        self._latencies.record("geofence_return_ms", (self._monotonic() - heard) * 1000)
        log.warning(
            "geofence_breach",
            flight=str(flight.id),
            command=str(intent),
            distance_outside_m=judgement.distance_outside_m,
            reason=judgement.reason,
        )
        outside = json.dumps(
            {
                "position": _lonlat(sample),
                "height_m": sample.height_m,
                "distance_outside_m": judgement.distance_outside_m,
                "above_ceiling_m": judgement.above_ceiling_m,
                "reason": judgement.reason,
            }
        )
        self._record(
            "geofence_breach",
            flight.id,
            functools.partial(self._record_breach, flight.id, intent, outside, sampled_at),
        )

    async def _record_breach(
        self, flight: uuid.UUID, intent: uuid.UUID, outside: str, sampled_at: datetime
    ) -> None:
        try:
            kept = await self._store.record_breach(flight, intent, outside, sampled_at)
        except TRANSIENT:
            raise
        except asyncpg.PostgresError:
            self._returner.recorded(intent, kept=False)
            raise
        if not kept:
            log.error("geofence_breach_not_recorded", flight=str(flight), command=str(intent))
        self._returner.recorded(intent, kept=kept)

    def _moments(self, watched: Watched, sample: Sample, sampled_at: datetime) -> None:
        mode = sample.mode_code
        if mode is None or mode in NOT_KNOWN:
            return
        airborne = mode not in ON_THE_GROUND
        if airborne and not watched.took_off:
            watched.took_off = True
            self._moment(watched, "took_off", sampled_at, mode)
        elif not airborne and watched.took_off and not watched.landed:
            watched.landed = True
            self._moment(watched, "landed", sampled_at, mode)
        elif airborne and watched.landed:
            # In the air again after a landing: the next landing is recorded too.
            watched.landed = False
        if mode == RETURNING and watched.mode is not None and watched.mode != RETURNING:
            self._moment(watched, "automatic_return", sampled_at, mode)
        watched.mode = mode

    def _moment(self, watched: Watched, moment: str, at: datetime, mode: int) -> None:
        flight = watched.flight.id
        log.info("flight_moment", flight=str(flight), moment=moment, mode_code=mode)
        self._record(
            moment, flight, functools.partial(self._store.record_moment, flight, moment, at, mode)
        )

    def _keep_in_track(
        self, watched: Watched, sample: Sample, sampled_at: datetime, received: float
    ) -> None:
        placed = _placed(sample)
        if placed is None:
            return
        longitude, latitude, height_m = placed
        slot = sample.taken_at_ms // HISTORY_SLOT_MS
        if watched.last_slot is not None and slot <= watched.last_slot:
            return
        watched.last_slot = slot
        flight = watched.flight
        self._track.append(
            TrackRow(
                flight_id=flight.id,
                sampled_at=sampled_at,
                organization_id=flight.organization_id,
                fleet_id=flight.fleet_id,
                received_at=datetime.fromtimestamp(received, UTC),
                longitude=longitude,
                latitude=latitude,
                height_m=height_m,
                heading_deg=sample.heading_deg,
                battery_pct=sample.battery_pct,
                satellites=sample.satellites,
                gps_quality=sample.gps_quality,
                mode_code=sample.mode_code,
                home_distance_m=sample.home_distance_m,
            )
        )

    # --- Staleness ----------------------------------------------------------------------

    async def _watch_staleness(self) -> None:
        while True:
            await asyncio.sleep(self._stale_tick_s)
            self.check_staleness()

    def check_staleness(self) -> None:
        """Raises telemetry_stale once for each executing flight with no sample for too long."""
        now = self._monotonic()
        for watched in self._flights.values():
            if not watched.executing or watched.stale or watched.on_the_ground_for_good:
                continue
            heard = watched.since
            if watched.last_received is not None:
                heard = max(heard, watched.last_received)
            if now - heard <= self._stale_after_s:
                continue
            watched.stale = True
            last = watched.last_sampled_ms
            self._log(
                watched,
                "telemetry_stale",
                {"last_sampled_at": None if last is None else _at(last).isoformat()},
                _at(round(self._clock() * 1000)),
            )
            log.warning(
                "telemetry_stale", flight=str(watched.flight.id), silent_s=round(now - heard, 3)
            )

    # --- Writing ------------------------------------------------------------------------

    def _log(self, watched: Watched, kind: str, payload: dict[str, Any], at: datetime) -> None:
        flight = watched.flight
        self._record(
            kind,
            flight.id,
            functools.partial(
                self._store.log,
                flight.operation_id,
                kind,
                json.dumps(payload),
                flight.id,
                flight.fleet_id,
                at,
            ),
        )

    def _record(self, name: str, flight: uuid.UUID, write: Callable[[], Awaitable[object]]) -> None:
        self._journal.append(Record(name, flight, write))
        self._journal_ready.set()

    async def _write_journal(self) -> None:
        while True:
            await self._journal_ready.wait()
            while self._journal:
                record = self._journal[0]
                try:
                    await record.write()
                except TRANSIENT:
                    await asyncio.sleep(self._retry_s)
                    continue
                except asyncpg.PostgresError as refusal:
                    log.error(
                        "flight_record_refused",
                        record=record.name,
                        flight=str(record.flight),
                        error=str(refusal),
                    )
                self._journal.popleft()
            self._journal_ready.clear()

    async def _write_latest(self) -> None:
        while True:
            await self._latest_changed.wait()
            self._latest_changed.clear()
            for aircraft in list(self._latest):
                latest = self._latest.pop(aircraft)
                try:
                    await self._store.record_latest(
                        aircraft, latest.gateway, latest.sample, latest.sampled_at
                    )
                except TRANSIENT:
                    # A newer sample that arrived meanwhile is the one written.
                    self._latest.setdefault(aircraft, latest)
                    self._latest_changed.set()
                    await asyncio.sleep(self._retry_s)
                    break
                except asyncpg.PostgresError as refusal:
                    log.error("aircraft_sample_refused", aircraft=aircraft, error=str(refusal))

    async def _write_track(self) -> None:
        while True:
            await asyncio.sleep(self._batch_s)
            await self.flush_track()

    async def flush_track(self) -> None:
        """Writes the samples kept since the last write, in one insert."""
        if not self._track:
            return
        rows, self._track = self._track, []
        try:
            await self._store.record_track(rows)
        except TRANSIENT:
            self._track[:0] = rows
        except asyncpg.PostgresError as refusal:
            log.error("track_refused", samples=len(rows), error=str(refusal))

    async def _reconcile(self) -> None:
        while True:
            await asyncio.sleep(self._reconcile_s)
            try:
                await self.sweep()
            except TRANSIENT:
                continue
            except asyncpg.PostgresError as refusal:
                log.error("flights_not_read", error=str(refusal))

    def _spawn(self, work: Awaitable[None]) -> None:
        task: asyncio.Task[None] = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def _fence(flight: Flight) -> Geofence | None:
    """The flight's geofence on the local frame of its first vertex, as soc-operations judged
    it; None, logged, when it cannot be judged against."""
    try:
        ring = flight.geofence["polygon"]
        longitude, latitude = ring[0]
        return geofence_of(Geodetic(latitude, longitude), ring, flight.geofence["max_height_m"])
    except (KeyError, IndexError, TypeError, ValueError) as error:
        log.error("flight_geofence_unusable", flight=str(flight.id), error=str(error))
        return None


def _flight_of(progress: FlightProgress) -> uuid.UUID | None:
    """The flight a progress is about: its flight_id, which the dock names as the prepare did."""
    if progress.flight_id is not None and progress.bid not in (None, progress.flight_id):
        log.warning("flight_progress_ids_disagree", bid=progress.bid, flight_id=progress.flight_id)
    named = progress.flight_id or progress.bid
    try:
        return None if named is None else uuid.UUID(named)
    except ValueError:
        return None


def _placed(sample: Sample) -> tuple[float, float, float] | None:
    """The sample's longitude, latitude and height, or None when it lacks any of them."""
    if sample.latitude_deg is None or sample.longitude_deg is None or sample.height_m is None:
        return None
    return (sample.longitude_deg, sample.latitude_deg, sample.height_m)


def _position(sample: Sample) -> Geodetic | None:
    if sample.latitude_deg is None or sample.longitude_deg is None:
        return None
    return Geodetic(sample.latitude_deg, sample.longitude_deg)


def _lonlat(sample: Sample) -> list[float] | None:
    if sample.latitude_deg is None or sample.longitude_deg is None:
        return None
    return [sample.longitude_deg, sample.latitude_deg]


def _at(milliseconds: int) -> datetime:
    return datetime.fromtimestamp(milliseconds / 1000, UTC)


def _json(value: object) -> str:
    import msgspec

    return msgspec.json.encode(value).decode()
