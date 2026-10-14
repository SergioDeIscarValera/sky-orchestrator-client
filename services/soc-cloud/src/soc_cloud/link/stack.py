"""One MQTT link to one Sky Orchestrator stack, as its cloud-client (FR-LNK-01).

A persistent MQTT v5 session: what the dock publishes at QoS 1 while SOC is away
waits for it. Every reply leaves only after passing its vendored schema
(FR-LNK-10). A session taken over by another client is reported as
`link_displaced` and backs off before taking it back.

The socket sends at once (TCP_NODELAY): with Nagle's algorithm, a command
published while replies arrive waited up to 80 ms for a delayed ACK.

A flight's progress (`flighttask_progress` on `events`) is decoded as sent and handed
on; the dock asks no reply for it. Other events are not read yet.

Mosquitto 2.0.22, Sky Orchestrator's broker, ends a taken-over session with a
server DISCONNECT whose reason is "normal"; MQTT 5 names reason 142 for it. A
lost broker sends neither. Both are read as a takeover; everything else is a
lost link.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import aiomqtt
import msgspec
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

import soc_log
from soc_cloud.link import topics
from soc_cloud.link.messages import (
    RESOURCE_GET,
    UPDATE_TOPO,
    AircraftOsd,
    DockOsd,
    Envelope,
    ResourceGet,
    ServiceReply,
    StateData,
    UpdateTopo,
)
from soc_cloud.link.progress import PROGRESS, FlightProgress, decode_progress
from soc_cloud.link.telemetry import Sample, sample
from soc_cloud.link.topology import Topology
from soc_cloud.presence import LinkState, NoPresence, Presence
from soc_cloud.settings import Stack, StackCredentials
from soc_cloud.wire import WireContract, WireRefusedError
from soc_supervision import Backoff, Health, Supervisor

QOS = 1
SESSION_EXPIRY_S = 3600
KEEPALIVE_S = 30
CONNECT_TIMEOUT_S = 10.0
SESSION_TAKEN_OVER = 142
ACCEPTED = 0
UNKNOWN_FLIGHT = 1

ClientFactory = Callable[..., aiomqtt.Client]

log = soc_log.get(__name__)


class LinkDisplacedError(aiomqtt.MqttError):
    pass


class LinkDownError(Exception):
    pass


@dataclass(frozen=True)
class FileOffer:
    url: str
    fingerprint: str


def no_files(_flight_id: str) -> FileOffer | None:
    return None


def no_replies(_tid: str, _result: int) -> None:
    pass


def no_announcements(_gateway: str) -> None:
    pass


def no_progress(_progress: FlightProgress) -> None:
    pass


def no_presence(_aircraft: str, _online: bool) -> None:
    pass


class _Event(msgspec.Struct, frozen=True):
    method: str | None = None


def displaced(error: BaseException) -> bool:
    cause = error.__cause__
    if cause is None:
        return True
    return isinstance(cause, aiomqtt.MqttCodeError) and cause.rc == SESSION_TAKEN_OVER


class StackLink:
    def __init__(
        self,
        stack: Stack,
        credentials: StackCredentials,
        wire: WireContract,
        *,
        on_sample: Callable[[Sample], None],
        files: Callable[[str], FileOffer | None] = no_files,
        on_reply: Callable[[str, int], None] = no_replies,
        on_announced: Callable[[str], None] = no_announcements,
        on_progress: Callable[[FlightProgress], None] = no_progress,
        on_presence: Callable[[str, bool], None] = no_presence,
        presence: Presence | None = None,
        client_factory: ClientFactory = aiomqtt.Client,
        backoff: Backoff | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.stack = stack
        self.topology = Topology()
        self._credentials = credentials
        self._wire = wire
        self._on_sample = on_sample
        self._files = files
        self._on_reply = on_reply
        self._on_announced = on_announced
        self._on_progress = on_progress
        self._on_presence = on_presence
        self._presence = presence or NoPresence()
        self._link = LinkState.CONNECTING
        self._client: aiomqtt.Client | None = None
        self._client_factory = client_factory
        self._clock = clock
        self._supervisor = Supervisor(
            f"stack:{stack.name}",
            connect=self._open,
            serve=self._serve,
            disconnect=self._close,
            transient=(aiomqtt.MqttError, OSError, TimeoutError),
            backoff=backoff,
            sleep=sleep,
        )

    @property
    def health(self) -> Health:
        return self._supervisor.health

    async def run(self) -> None:
        await self._supervisor.run()

    def serves(self, gateway: str) -> bool:
        return self._client is not None and gateway in self.topology.gateways()

    async def send_service(self, gateway: str, message: dict[str, Any]) -> None:
        client = self._client
        if client is None:
            raise LinkDownError(f"stack {self.stack.name} is not connected")
        await self._publish(
            client, f"services/{message['method']}", topics.services(gateway), message
        )

    async def _open(self) -> aiomqtt.Client:
        session = Properties(PacketTypes.CONNECT)
        session.SessionExpiryInterval = SESSION_EXPIRY_S
        broker = self.stack.broker
        client = self._client_factory(
            broker.host,
            broker.port,
            username=broker.username,
            password=self._credentials.broker_password.reveal(),
            identifier=broker.client_id,
            protocol=aiomqtt.ProtocolVersion.V5,
            clean_start=False,
            properties=session,
            keepalive=KEEPALIVE_S,
            timeout=CONNECT_TIMEOUT_S,
            socket_options=[(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)],
        )
        await client.__aenter__()
        try:
            for subscription in topics.SUBSCRIPTIONS:
                await client.subscribe(subscription, qos=QOS)
        except BaseException:
            await self._close(client)
            raise
        self._client = client
        self._report_link(LinkState.CONNECTED)
        return client

    async def _serve(self, client: aiomqtt.Client) -> None:
        try:
            async for message in client.messages:
                await self.receive(client, message.topic.value, message.payload)
        except aiomqtt.MqttError as error:
            if displaced(error):
                log.warning("link_displaced", stack=self.stack.name)
                self._report_link(LinkState.DISPLACED)
                raise LinkDisplacedError("another cloud-client took the session") from error
            self._report_link(LinkState.UNREACHABLE)
            raise
        self._report_link(LinkState.UNREACHABLE)

    async def _close(self, client: aiomqtt.Client) -> None:
        self._client = None
        with contextlib.suppress(aiomqtt.MqttError, OSError):
            await client.__aexit__(None, None, None)

    async def receive(self, client: aiomqtt.Client, topic: str, payload: Any) -> None:
        parsed = topics.parse(topic)
        if parsed is None or not isinstance(payload, bytes | bytearray):
            return
        body = bytes(payload)
        try:
            if parsed.kind is topics.Inbound.STATUS:
                await self._status(client, parsed.sn, body)
            elif parsed.kind is topics.Inbound.OSD:
                self._osd(parsed.sn, body)
            elif parsed.kind is topics.Inbound.STATE:
                self._state(parsed.sn, body)
            elif parsed.kind is topics.Inbound.EVENTS:
                self._event(topic, body)
            elif parsed.kind is topics.Inbound.REQUESTS:
                await self._request(client, parsed.sn, body)
            elif parsed.kind is topics.Inbound.SERVICES_REPLY:
                reply = msgspec.json.decode(body, type=ServiceReply)
                self._on_reply(reply.tid, reply.data.result)
        except (msgspec.DecodeError, msgspec.ValidationError) as error:
            log.warning("message_unreadable", stack=self.stack.name, topic=topic, error=str(error))
        except WireRefusedError as refusal:
            log.error(
                "reply_refused_by_schema",
                stack=self.stack.name,
                kind=refusal.kind,
                problems=refusal.problems,
            )

    async def _status(self, client: aiomqtt.Client, gateway: str, payload: bytes) -> None:
        announcement = msgspec.json.decode(payload, type=UpdateTopo)
        if announcement.method != UPDATE_TOPO:
            return
        with soc_log.correlated(stack=self.stack.name, tid=announcement.tid, bid=announcement.bid):
            for change in self.topology.announce(gateway, announcement.data):
                self._log_presence(change.aircraft, change.online)
            self._presence.link(gateway, self._link)
            self._presence.topology(gateway, self.topology.devices(gateway))
            reply = self._reply(
                announcement.tid, announcement.bid, UPDATE_TOPO, {"result": ACCEPTED}
            )
            await self._publish(client, "sys/status_reply", topics.status_reply(gateway), reply)
        self._on_announced(gateway)

    def _osd(self, serial: str, payload: bytes) -> None:
        envelope = msgspec.json.decode(payload, type=Envelope)
        if serial == envelope.gateway:
            dock = msgspec.json.decode(envelope.data, type=DockOsd)
            changes = self.topology.report(serial, dock)
            for change in changes:
                self._log_presence(change.aircraft, change.online)
            if changes:
                self._presence.topology(serial, self.topology.devices(serial))
            return
        aircraft = msgspec.json.decode(envelope.data, type=AircraftOsd)
        self._on_sample(
            sample(self.stack.name, envelope.gateway, serial, envelope.timestamp, aircraft)
        )

    def _state(self, serial: str, payload: bytes) -> None:
        envelope = msgspec.json.decode(payload, type=Envelope)
        state = msgspec.json.decode(envelope.data, type=StateData)
        if serial != envelope.gateway and state.firmware_version is not None:
            self._presence.firmware(envelope.gateway, serial, state.firmware_version)

    def _event(self, topic: str, payload: bytes) -> None:
        if msgspec.json.decode(payload, type=_Event).method != PROGRESS:
            return
        try:
            progress = decode_progress(payload)
        except ValueError as error:
            log.warning("message_unreadable", stack=self.stack.name, topic=topic, error=str(error))
            return
        self._on_progress(progress)

    def _report_link(self, state: LinkState) -> None:
        self._link = state
        for gateway in sorted(self.topology.gateways()):
            self._presence.link(gateway, state)

    async def _request(self, client: aiomqtt.Client, gateway: str, payload: bytes) -> None:
        request = msgspec.json.decode(payload, type=Envelope)
        if request.method != RESOURCE_GET:
            log.warning("request_not_handled", stack=self.stack.name, method=request.method)
            return
        flight_id = msgspec.json.decode(request.data, type=ResourceGet).flight_id
        with soc_log.correlated(stack=self.stack.name, tid=request.tid, bid=request.bid):
            offer = self._files(flight_id)
            if offer is None:
                data: dict[str, Any] = {
                    "result": UNKNOWN_FLIGHT,
                    "output": f"SOC has no flight file for {flight_id}",
                }
            else:
                file = {"url": offer.url, "fingerprint": offer.fingerprint}
                data = {"result": ACCEPTED, "output": {"file": file}}
            reply = self._reply(request.tid, request.bid, RESOURCE_GET, data)
            await self._publish(
                client,
                "requests/flighttask_resource_get_reply",
                topics.requests_reply(gateway),
                reply,
            )
            log.info("flight_file_requested", flight_id=flight_id, offered=offer is not None)

    def _reply(self, tid: str, bid: str, method: str, data: dict[str, Any]) -> dict[str, Any]:
        timestamp = int(self._clock() * 1000)
        return {"tid": tid, "bid": bid, "timestamp": timestamp, "method": method, "data": data}

    async def _publish(
        self, client: aiomqtt.Client, kind: str, topic: str, message: dict[str, Any]
    ) -> None:
        self._wire.check(kind, message)
        await client.publish(topic, msgspec.json.encode(message), qos=QOS)

    def _log_presence(self, aircraft: str, online: bool) -> None:
        event = "aircraft_online" if online else "aircraft_offline"
        log.info(event, stack=self.stack.name, device=aircraft)
        self._on_presence(aircraft, online)
