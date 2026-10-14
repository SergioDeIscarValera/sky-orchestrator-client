"""Command intents put on the wire (ADR-0006, FR-LNK-06).

Each intent is announced by `pg_notify` when it commits; every reconnection's
sweep finds those announced while SOC was away. An intent is checked against its
vendored schema, claimed (or expired, if older than `command_intent_ttl_s`),
published on its dock's `services` topic with tid = intent and bid = flight, and
settled by the `services_reply` carrying its tid, or timed out after
`command_reply_timeout_s`. Claims are conditional, so an intent announced three
times runs once (NFR-REL-02).

An intent for a dock no connected stack has announced waits: it runs when a link
announces that dock (Sky Orchestrator announces as soon as a cloud connects), or,
once `command_intent_ttl_s` has passed, its claim expires it.

A prepare goes out only once its flight's file is kept to be served (`on_prepare`); a
reply is reported to `on_settled` once recorded. soc-cloud's own return home on a
geofence breach (FR-SAF-01) is put on the wire by `send_now` before any record, within
the breach's 100 ms: its reply waits until `recorded` says the intent is in the database,
then settles it as any other's.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime
from typing import Any, Protocol

import aiomqtt
import msgspec

import soc_log
from soc_cloud.latency import Latencies
from soc_cloud.link.stack import LinkDownError, StackLink
from soc_cloud.wire import WireContract, WireRefusedError
from soc_db import Database

CHANNEL = "soc_command_intents"
EXPIRY_MARGIN_S = 0.05
SERVICE_METHODS = {
    "prepare": "flighttask_prepare",
    "execute": "flighttask_execute",
    "pause": "flighttask_pause",
    "recovery": "flighttask_recovery",
    "undo": "flighttask_undo",
    "return_home": "return_home",
}
log = soc_log.get(__name__)


class Intent(msgspec.Struct, frozen=True):
    id: uuid.UUID
    organization_id: uuid.UUID
    operation_id: uuid.UUID
    flight_id: uuid.UUID
    gateway_sn: str
    verb: str
    payload: dict[str, Any]
    status: str
    requested_at: datetime
    sent_at: datetime | None


async def any_prepare(_intent: Intent) -> bool:
    return True


def no_settlement(_intent: Intent, _result: int) -> None:
    pass


class CommandStore(Protocol):
    async def pending(self) -> list[uuid.UUID]: ...
    async def awaiting_reply(self) -> list[Intent]: ...
    async def get(self, intent: uuid.UUID) -> Intent | None: ...
    async def claim(self, intent: uuid.UUID, ttl_s: int) -> Intent | None: ...
    async def fail(self, intent: uuid.UUID) -> Intent | None: ...
    async def record_reply(self, intent: uuid.UUID, result: int) -> Intent | None: ...
    async def time_out(self, intent: uuid.UUID) -> Intent | None: ...


class PostgresCommandStore:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def pending(self) -> list[uuid.UUID]:
        async with self._database.session() as connection:
            rows = await connection.fetch(
                "select id from soc.command_intents where status = 'pending' order by requested_at"
            )
        return [row["id"] for row in rows]

    async def awaiting_reply(self) -> list[Intent]:
        return await self._many(
            "select * from soc.command_intents where status = 'sent' order by sent_at"
        )

    async def get(self, intent: uuid.UUID) -> Intent | None:
        return await self._one("select * from soc.command_intents where id = $1", intent)

    async def claim(self, intent: uuid.UUID, ttl_s: int) -> Intent | None:
        return await self._one("select * from soc.claim_command_intent($1, $2)", intent, ttl_s)

    async def fail(self, intent: uuid.UUID) -> Intent | None:
        return await self._one("select * from soc.fail_command_intent($1)", intent)

    async def record_reply(self, intent: uuid.UUID, result: int) -> Intent | None:
        return await self._one("select * from soc.record_command_reply($1, $2)", intent, result)

    async def time_out(self, intent: uuid.UUID) -> Intent | None:
        return await self._one("select * from soc.time_out_command_intent($1)", intent)

    async def _one(self, query: str, *arguments: object) -> Intent | None:
        found = await self._many(query, *arguments)
        return found[0] if found else None

    async def _many(self, query: str, *arguments: object) -> list[Intent]:
        async with self._database.session() as connection:
            rows = await connection.fetch(query, *arguments)
        return [
            Intent(
                **{field: row[field] for field in Intent.__struct_fields__ if field != "payload"},
                payload=json.loads(row["payload"]),
            )
            for row in rows
        ]


class Commands:
    def __init__(
        self,
        store: CommandStore,
        links: Sequence[StackLink],
        wire: WireContract,
        *,
        ttl_s: int,
        reply_timeout_s: float,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        latencies: Latencies | None = None,
        on_prepare: Callable[[Intent], Awaitable[bool]] = any_prepare,
        on_settled: Callable[[Intent, int], None] = no_settlement,
    ) -> None:
        self._store = store
        self._links = links
        self._wire = wire
        self._ttl_s = ttl_s
        self._reply_timeout_s = reply_timeout_s
        self._clock = clock
        self._monotonic = monotonic
        self._latencies = latencies or Latencies()
        self._published: dict[uuid.UUID, float] = {}
        self._deadlines: dict[uuid.UUID, asyncio.TimerHandle] = {}
        self._waiting: dict[str, set[uuid.UUID]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._on_prepare = on_prepare
        self._on_settled = on_settled
        # Sent by send_now and not recorded yet: the reply already heard, if any.
        self._unrecorded: dict[uuid.UUID, int | None] = {}

    async def announced(self, payload: str) -> None:
        try:
            intent = uuid.UUID(payload)
        except ValueError:
            log.warning("command_announcement_unreadable", payload=payload)
            return
        await self.execute(intent)

    async def sweep(self) -> None:
        for intent in await self._store.awaiting_reply():
            assert intent.sent_at is not None
            waited_s = self._clock() - intent.sent_at.timestamp()
            self._await_reply(intent.id, max(0.0, self._reply_timeout_s - waited_s))
        for pending in await self._store.pending():
            await self.execute(pending)

    async def execute(self, intent_id: uuid.UUID) -> None:
        intent = await self._store.get(intent_id)
        if intent is None or intent.status != "pending":
            return
        with soc_log.correlated(
            organization=intent.organization_id,
            operation=intent.operation_id,
            flight=intent.flight_id,
            command=intent.id,
            tid=intent.id,
            bid=intent.flight_id,
        ):
            await self._execute(intent)

    def announced_gateway(self, gateway: str) -> None:
        for intent in sorted(self._waiting.pop(gateway, set())):
            self._spawn(self.execute(intent))

    def replied(self, tid: str, result: int) -> None:
        try:
            intent = uuid.UUID(tid)
        except ValueError:
            return
        if intent in self._unrecorded:
            if self._unrecorded[intent] is None:
                self._unrecorded[intent] = result
            return
        self._spawn(self._record(intent, result))

    async def send_now(self, gateway: str, flight: uuid.UUID, verb: str) -> uuid.UUID | None:
        """Puts a command soc-cloud decided itself on the wire at once; its intent, or None.

        Nothing is read or written first: the caller records the intent, then calls
        `recorded`. None when no connected stack serves the dock, the schema refuses the
        message or the publish fails, each logged.
        """
        intent = uuid.uuid4()
        method = SERVICE_METHODS[verb]
        message: dict[str, Any] = {
            "tid": str(intent),
            "bid": str(flight),
            "timestamp": int(self._clock() * 1000),
            "method": method,
            "data": {},
        }
        with soc_log.correlated(flight=flight, command=intent, tid=intent, bid=flight):
            link = next((link for link in self._links if link.serves(gateway)), None)
            if link is None:
                log.error("command_not_published", verb=verb, error=f"no stack serves {gateway}")
                return None
            try:
                self._wire.check(f"services/{method}", message)
            except WireRefusedError as refusal:
                log.error("command_refused_by_schema", verb=verb, problems=refusal.problems)
                return None
            self._unrecorded[intent] = None
            self._published[intent] = self._monotonic()
            try:
                await link.send_service(gateway, message)
            except (aiomqtt.MqttError, LinkDownError, WireRefusedError) as error:
                self._unrecorded.pop(intent, None)
                self._published.pop(intent, None)
                log.error("command_not_published", verb=verb, error=str(error))
                return None
            log.info("command_sent", verb=verb, stack=link.stack.name, by="soc-cloud")
        return intent

    def recorded(self, intent: uuid.UUID, *, kept: bool) -> None:
        """The intent `send_now` sent is in the database (kept), or never will be."""
        if intent not in self._unrecorded:
            return
        heard = self._unrecorded.pop(intent)
        if not kept:
            self._published.pop(intent, None)
            return
        if heard is not None:
            self._spawn(self._record(intent, heard))
            return
        published = self._published.get(intent, self._monotonic())
        waited_s = self._monotonic() - published
        self._await_reply(intent, max(0.0, self._reply_timeout_s - waited_s))

    async def _execute(self, intent: Intent) -> None:
        method = SERVICE_METHODS[intent.verb]
        message = {
            "tid": str(intent.id),
            "bid": str(intent.flight_id),
            "timestamp": int(self._clock() * 1000),
            "method": method,
            "data": intent.payload,
        }
        link = next((link for link in self._links if link.serves(intent.gateway_sn)), None)
        if link is None:
            self._wait_for_its_dock(intent)
            return
        try:
            self._wire.check(f"services/{method}", message)
        except WireRefusedError as refusal:
            log.error("command_refused_by_schema", verb=intent.verb, problems=refusal.problems)
            await self._store.fail(intent.id)
            return
        if intent.verb == "prepare" and not await self._on_prepare(intent):
            log.error("command_without_its_flight_file", verb=intent.verb)
            await self._store.fail(intent.id)
            return
        claimed = await self._store.claim(intent.id, self._ttl_s)
        if claimed is None:
            return
        if claimed.status == "expired":
            log.warning("command_expired", verb=intent.verb, ttl_s=self._ttl_s)
            return
        self._await_reply(intent.id, self._reply_timeout_s)
        try:
            await link.send_service(intent.gateway_sn, message)
        except (aiomqtt.MqttError, LinkDownError, WireRefusedError) as error:
            log.error("command_not_published", verb=intent.verb, error=str(error))
            return
        self._published[intent.id] = self._monotonic()
        self._latencies.record(
            "command_publish_ms", (self._clock() - intent.requested_at.timestamp()) * 1000
        )
        assert claimed.sent_at is not None
        log.info(
            "command_sent",
            verb=intent.verb,
            stack=link.stack.name,
            announced_ms=round((claimed.sent_at - intent.requested_at).total_seconds() * 1000),
        )

    async def _record(self, intent: uuid.UUID, result: int) -> None:
        deadline = self._deadlines.pop(intent, None)
        if deadline is not None:
            deadline.cancel()
        published = self._published.pop(intent, None)
        if published is not None:
            self._latencies.record("command_reply_ms", (self._monotonic() - published) * 1000)
        settled = await self._store.record_reply(intent, result)
        if settled is not None:
            log.info("command_replied", command=intent, verb=settled.verb, result=result)
            self._on_settled(settled, result)

    async def _time_out(self, intent: uuid.UUID) -> None:
        self._deadlines.pop(intent, None)
        self._published.pop(intent, None)
        if await self._store.time_out(intent) is not None:
            log.warning("command_timed_out", command=intent, after_s=self._reply_timeout_s)

    def _wait_for_its_dock(self, intent: Intent) -> None:
        log.info("command_waits_for_its_dock", gateway=intent.gateway_sn, verb=intent.verb)
        self._waiting.setdefault(intent.gateway_sn, set()).add(intent.id)
        age_s = self._clock() - intent.requested_at.timestamp()
        asyncio.get_running_loop().call_later(
            max(0.0, self._ttl_s - age_s) + EXPIRY_MARGIN_S,
            lambda: self._spawn(self._expire_if_still_waiting(intent)),
        )

    async def _expire_if_still_waiting(self, intent: Intent) -> None:
        waiting = self._waiting.get(intent.gateway_sn, set())
        if intent.id not in waiting:
            return
        waiting.discard(intent.id)
        claimed = await self._store.claim(intent.id, self._ttl_s)
        if claimed is not None and claimed.status == "expired":
            log.warning("command_expired", verb=intent.verb, gateway=intent.gateway_sn)

    def _await_reply(self, intent: uuid.UUID, within_s: float) -> None:
        loop = asyncio.get_running_loop()
        self._deadlines[intent] = loop.call_later(
            within_s, lambda: self._spawn(self._time_out(intent))
        )

    def _spawn(self, work: Any) -> None:
        task = asyncio.get_running_loop().create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
