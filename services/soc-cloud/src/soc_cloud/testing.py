"""Test doubles for soc-cloud: a fake MQTT client, and Sky Orchestrator's broker.

`EphemeralMosquitto` runs the broker image Sky Orchestrator pins, configured as
its infra/mosquitto does where it matters to a cloud: no anonymous clients, the
username as the client identifier (a second connection takes the session over),
persistence, and the cloud-client's topic rights. A `dock` user plays
so-gateway's side.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import shutil
import socket
import subprocess
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import aiomqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.reasoncodes import ReasonCode

MOSQUITTO_IMAGE = (
    "eclipse-mosquitto:2.0.22"
    "@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21"
)
DOCKER = shutil.which("docker") or "docker"
READY_WITHIN_S = 30
CLOUD_CLIENT = "cloud-client"
DOCK = "dock"

MOSQUITTO_CONF = """\
per_listener_settings false
listener 1883
protocol mqtt
allow_anonymous false
password_file /run/mosquitto/passwd
acl_file /run/mosquitto/acl
use_username_as_clientid true
persistence true
persistence_location /mosquitto/data/
log_dest stdout
log_type error
log_type warning
log_type notice
log_type information
connection_messages true
"""

ACL = """\
user cloud-client
topic read thing/#
topic read sys/#
topic write thing/product/+/services
topic write thing/product/+/property/set
topic write thing/product/+/events_reply
topic write thing/product/+/requests_reply
topic write thing/product/+/drc/down
topic write sys/product/+/status_reply

user dock
topic readwrite thing/#
topic readwrite sys/#
"""

ENTRYPOINT = """\
set -eu
umask 077
mkdir -p /run/mosquitto
printf '%s' "$MOSQUITTO_CONF" > /run/mosquitto/mosquitto.conf
printf '%s' "$MOSQUITTO_ACL" > /run/mosquitto/acl
printf 'cloud-client:%s\\ndock:%s\\n' "$CLOUD_PASSWORD" "$DOCK_PASSWORD" > /run/mosquitto/passwd
mosquitto_passwd -U /run/mosquitto/passwd
chown -R mosquitto:mosquitto /run/mosquitto /mosquitto/data
exec /usr/sbin/mosquitto -c /run/mosquitto/mosquitto.conf
"""


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def _docker(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run([DOCKER, *arguments], capture_output=True, text=True, check=check)


@dataclass
class EphemeralMosquitto:
    name: str = field(default_factory=lambda: f"soc-mqtttest-{secrets.token_hex(4)}")
    port: int = field(default_factory=_free_port)
    cloud_password: str = field(default_factory=lambda: secrets.token_hex(20), repr=False)
    dock_password: str = field(default_factory=lambda: secrets.token_hex(20), repr=False)

    def start(self) -> None:
        _docker(
            "run", "-d", "--name", self.name,
            "-p", f"127.0.0.1:{self.port}:1883",
            "-e", f"MOSQUITTO_CONF={MOSQUITTO_CONF}",
            "-e", f"MOSQUITTO_ACL={ACL}",
            "-e", f"CLOUD_PASSWORD={self.cloud_password}",
            "-e", f"DOCK_PASSWORD={self.dock_password}",
            "--entrypoint", "sh",
            MOSQUITTO_IMAGE, "-c", ENTRYPOINT,
        )  # fmt: skip
        self._wait_until_ready()

    def restart(self) -> None:
        _docker("restart", self.name)
        self._wait_until_ready()

    def stop(self) -> None:
        _docker("rm", "-f", self.name, check=False)

    def dock(self, **options: Any) -> aiomqtt.Client:
        return aiomqtt.Client(
            "127.0.0.1",
            self.port,
            username=DOCK,
            password=self.dock_password,
            protocol=aiomqtt.ProtocolVersion.V5,
            **options,
        )

    def intruder(self) -> aiomqtt.Client:
        return aiomqtt.Client(
            "127.0.0.1",
            self.port,
            username=CLOUD_CLIENT,
            password=self.cloud_password,
            protocol=aiomqtt.ProtocolVersion.V5,
        )

    def _accepts_the_dock(self) -> bool:
        def text(value: str) -> bytes:
            return len(value).to_bytes(2, "big") + value.encode()

        body = (
            text("MQTT") + bytes([4, 0xC2, 0, 10])
            + text("probe") + text(DOCK) + text(self.dock_password)
        )  # fmt: skip
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=1) as probe:
                probe.sendall(bytes([0x10, len(body)]) + body)
                return probe.recv(4) == bytes([0x20, 0x02, 0x00, 0x00])
        except OSError:
            return False

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + READY_WITHIN_S
        while time.monotonic() < deadline:
            if self._accepts_the_dock():
                return
            time.sleep(0.2)
        logs = _docker("logs", "--tail", "20", self.name, check=False).stdout
        raise TimeoutError(f"{self.name} was not ready within {READY_WITHIN_S} s:\n{logs}")


@dataclass(frozen=True)
class FakeTopic:
    value: str


@dataclass(frozen=True)
class FakeMessage:
    topic: FakeTopic
    payload: bytes


class FakeClient:
    """The part of aiomqtt.Client a stack link uses, driven by the test."""

    def __init__(self, *arguments: Any, **options: Any) -> None:
        self.arguments = arguments
        self.options = options
        self.subscriptions: list[str] = []
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.closed = False
        self._inbox: asyncio.Queue[FakeMessage | BaseException] = asyncio.Queue()

    async def __aenter__(self) -> FakeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        self.closed = True

    async def subscribe(self, topic: str, qos: int = 0) -> None:
        self.subscriptions.append(topic)

    async def publish(self, topic: str, payload: bytes, qos: int = 0) -> None:
        self.published.append((topic, json.loads(payload)))

    def deliver(self, topic: str, message: dict[str, Any]) -> None:
        self._inbox.put_nowait(FakeMessage(FakeTopic(topic), json.dumps(message).encode()))

    def take_over(self) -> None:
        """As Mosquitto does: the server ends the session with a normal DISCONNECT."""
        self._inbox.put_nowait(aiomqtt.MqttError("Disconnected during message iteration"))

    def take_over_with_reason(self) -> None:
        """As MQTT 5 specifies: DISCONNECT with reason 142, session taken over."""
        self._end(aiomqtt.MqttCodeError(ReasonCode(PacketTypes.DISCONNECT, identifier=142)))

    def lose(self) -> None:
        """A broker gone: no DISCONNECT, an error code."""
        self._end(aiomqtt.MqttCodeError(7, "The connection was lost."))

    def _end(self, cause: aiomqtt.MqttCodeError) -> None:
        error = aiomqtt.MqttError("Disconnected during message iteration")
        error.__cause__ = cause
        self._inbox.put_nowait(error)

    @property
    def messages(self) -> AsyncIterator[FakeMessage]:
        return self._messages()

    async def _messages(self) -> AsyncIterator[FakeMessage]:
        while True:
            item = await self._inbox.get()
            if isinstance(item, BaseException):
                raise item
            yield item
