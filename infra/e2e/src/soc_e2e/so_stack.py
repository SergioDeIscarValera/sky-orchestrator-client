"""Sky Orchestrator's released stack, as SOC's end to end flies against it (SO's ADR-0039).

The compose files and the broker's configuration vendored at `contracts/sky-orchestrator/stack`,
the images Sky Orchestrator published at the vendored release, the external cloud role (SOC is
the cloud: it serves each flight file itself) and the fake bridge standing in for the phone, as
SO's own `infra/check.sh` brings one up. Everything is its own and written fresh: the compose
project, the loopback ports, the credentials and every service's configuration, all removed
with it. It never touches another stack on the machine.

The services' files are written from the vendored configuration contract: each takes exactly
its consumer's keys. The fake bridge's envelope is set equal to so-wayline's, as the phone's is
set by hand (DEP-03), so a file so-wayline accepts the application accepts too.

so-wayline fetches each flight file from inside its container (SO's fetch.py), so the file must
be served where that container reaches: `gateway` is the project network's address on this
host, where a process here can listen.
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from soc_database.harness import docker

ROOT = Path(__file__).resolve().parents[4]
VENDORED = ROOT / "contracts" / "sky-orchestrator"
COMPOSE = VENDORED / "stack" / "compose" / "compose.yaml"
RELEASE = VENDORED / "stack" / "compose" / "compose.release.yaml"
SCHEMA = VENDORED / "config" / "so-config.schema.json"
#: Every project this harness makes starts so, and it removes no other.
PROJECT_PREFIX = "soc-e2e-so-"
#: The services the external role runs with the fake bridge; the store and the phone's link
#: stay off (SO's .env.example, its check.sh).
PROFILES = "fake-bridge"
READY_WITHIN_S = 180
#: The application's consumer name in the configuration contract: the fake bridge runs it.
PHONE = "so-msdk-v4"
#: Letters and digits, 64 of them: what every one of SO's secrets accepts (so_config's SECRET).
SECRET = re.compile(r"^[A-Za-z0-9]{32,}$")


def secret() -> str:
    return secrets.token_hex(32)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def release() -> str:
    """The release the vendored files come from, whose images the stack runs."""
    provenance: dict[str, str] = json.loads((VENDORED / "vendored.json").read_text())
    return provenance["describe"]


def schema() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return loaded


def consumer_keys(contract: Mapping[str, Any], consumer: str) -> dict[str, Mapping[str, Any]]:
    """The properties the contract gives one consumer, by name."""
    return {
        name: prop
        for name, prop in contract["properties"].items()
        if consumer in prop.get("x-consumers", [])
    }


def defaults(contract: Mapping[str, Any], consumer: str) -> dict[str, Any]:
    """A consumer's keys at their defaults, as SO's tools/device_config.py template writes them."""
    return {
        name: prop["default"]
        for name, prop in consumer_keys(contract, consumer).items()
        if "default" in prop
    }


@dataclass(frozen=True)
class Site:
    """Where the stack lets the aircraft fly: so-wayline's envelope, and the phone's."""

    latitude_deg: float
    longitude_deg: float
    radius_m: float = 500
    max_height_m: float = 100
    max_home_distance_m: float = 500
    max_horizontal_speed_ms: float = 12
    max_leg_m: float = 300
    max_transit_m: float = 500
    max_total_distance_m: float = 5000
    max_waypoints: int = 100

    def envelope(self) -> dict[str, Any]:
        """The envelope keys so-wayline and the application share."""
        return {
            "geofence_center": {
                "latitude_deg": self.latitude_deg,
                "longitude_deg": self.longitude_deg,
            },
            "geofence_radius_m": self.radius_m,
            "max_height_m": self.max_height_m,
            "max_home_distance_m": self.max_home_distance_m,
            "max_horizontal_speed_ms": self.max_horizontal_speed_ms,
            "max_leg_m": self.max_leg_m,
            "max_transit_m": self.max_transit_m,
            "max_total_distance_m": self.max_total_distance_m,
            "max_waypoints": self.max_waypoints,
        }


@dataclass
class SoStack:
    """One throwaway Sky Orchestrator stack: start it, fly against it, stop it."""

    site: Site
    dock_sn: str = "SOCE2EDOCK01"
    aircraft_sn: str = "SOCE2EUAV001"
    #: Simulated seconds per wall second on the fake bridge (SO's FAKE_BRIDGE_PACE).
    pace: int = 10
    osd_hz: float = 5
    simulator_mode: bool = True
    #: The fake bridge launched as a phone ready for real flight: its simulator off and real
    #: flight confirmed (SO's FAKE_BRIDGE_REAL, DEP-28).
    real_launch: bool = False
    version: str = field(default_factory=release)
    project: str = field(default_factory=lambda: PROJECT_PREFIX + secrets.token_hex(4))
    mqtt_port: int = field(default_factory=free_port)
    wayline_port: int = field(default_factory=free_port)
    credentials: dict[str, str] = field(
        default_factory=lambda: {
            name: secret()
            for name in (
                "SO_MQTT_PASSWORD_SO_GATEWAY",
                "SO_MQTT_PASSWORD_SO_FLEET",
                "SO_MQTT_PASSWORD_SO_WAYLINE",
                "SO_MQTT_PASSWORD_SO_BRIDGE",
                "SO_MQTT_PASSWORD_CLOUD_CLIENT",
                "SO_WAYLINE_API_TOKEN",
                "SO_BRIDGE_SECRET",
            )
        },
        repr=False,
    )
    directory: Path = field(default_factory=lambda: Path(tempfile.mkdtemp(prefix="soc-e2e-so-")))

    # --- What the cloud connects with ------------------------------------------------------

    @property
    def cloud_password(self) -> str:
        return self.credentials["SO_MQTT_PASSWORD_CLOUD_CLIENT"]

    @property
    def api_token(self) -> str:
        return self.credentials["SO_WAYLINE_API_TOKEN"]

    @property
    def api_url(self) -> str:
        return f"http://127.0.0.1:{self.wayline_port}"

    # --- The files --------------------------------------------------------------------------

    def environment(self) -> dict[str, str]:
        """The compose project's variables, as SO's check.sh writes them for the external role."""
        work = self.directory
        return {
            "COMPOSE_PROFILES": PROFILES,
            "SO_VERSION": self.version,
            "SO_BIND": "127.0.0.1",
            "SO_MQTT_PORT": str(self.mqtt_port),
            "SO_WAYLINE_PORT": str(self.wayline_port),
            **self.credentials,
            "SO_WAYLINE_CONFIG": str(work / "so-wayline.json"),
            "SO_BRIDGE_URL": "http://fake-bridge:8765",
            "SO_BRIDGE_CONFIG": str(work / "so-bridge.json"),
            "SO_FLEET_CONFIG": str(work / "so-fleet.json"),
            "SO_GATEWAY_CONFIG": str(work / "so-gateway.json"),
            "FAKE_BRIDGE_CONFIG": str(work / "fake-bridge.json"),
            "FAKE_BRIDGE_ARM": "1",
            "FAKE_BRIDGE_PACE": str(self.pace),
            "FAKE_BRIDGE_REAL": "1" if self.real_launch else "0",
            # Named, though the fake cloud does not run: compose reads every service's paths.
            "FAKE_CLOUD_DIR": str(work / "cloud"),
        }

    def configurations(self) -> dict[str, dict[str, Any]]:
        """Each service's file, by its name in the directory."""
        contract = schema()
        identity = {"domain": 0, "type": 91, "sub_type": 0, "firmware_version": "10.1.0"}
        return {
            "so-wayline.json": {
                **self.site.envelope(),
                "max_kmz_bytes": 10_485_760,
                "presign_ttl_s": 10,
                "cloud_role": "external",
            },
            "so-bridge.json": {
                "bridge_heartbeat_timeout_ms": 3000,
                "simulator_mode": self.simulator_mode,
            },
            "so-fleet.json": {
                "telemetry_stale_after_ms": 2000,
                "device_offline_timeout_s": 10,
                "cloud_role": "external",
                "dock_identity": {
                    "sn": self.dock_sn,
                    "domain": 3,
                    "type": 2,
                    "sub_type": 0,
                    "firmware_version": "10.1.0",
                },
                "aircraft_identity": {"sn": self.aircraft_sn, **identity},
            },
            "so-gateway.json": {
                "osd_publish_hz": self.osd_hz,
                "progress_publish_hz": 1,
                "telemetry_stale_after_ms": 2000,
                "device_offline_timeout_s": 5,
                "capture_max_bytes": 16_777_216,
                "cloud_role": "external",
            },
            # The application's own: its defaults, so-wayline's envelope for every key of it
            # the application takes, and an arming that outlasts the run on the simulated
            # clock (SO's check.sh).
            "fake-bridge.json": {
                **defaults(contract, PHONE),
                **{
                    name: value
                    for name, value in self.site.envelope().items()
                    if name in consumer_keys(contract, PHONE)
                },
                "arming_ttl_s": 3600,
                "capture_max_bytes": 16_777_216,
            },
        }

    def write(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "cloud").mkdir(exist_ok=True)
        # The containers' own users read these; they hold no secret (the env file does).
        self.directory.chmod(0o755)
        (self.directory / "cloud").chmod(0o755)
        for name, values in self.configurations().items():
            path = self.directory / name
            path.write_text(json.dumps(values, indent=2) + "\n", encoding="utf-8")
            path.chmod(0o644)
        env = self.directory / "stack.env"
        env.write_text(
            "".join(f"{name}={value}\n" for name, value in self.environment().items()),
            encoding="utf-8",
        )
        env.chmod(0o600)

    # --- The stack --------------------------------------------------------------------------

    def compose(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return docker(
            "compose", "-p", self.project,
            "--env-file", str(self.directory / "stack.env"),
            "-f", str(COMPOSE), "-f", str(RELEASE),
            *arguments,
            check=check,
        )  # fmt: skip

    def start(self, ready_within_s: float = READY_WITHIN_S) -> None:
        """Pulls the release's images, starts the stack and waits for it to fly."""
        self.write()
        pulled = self.compose("pull", "--quiet", check=False)
        if pulled.returncode != 0:
            # Docker's own words say why: a registry that denies the token reads "denied".
            raise RuntimeError(
                f"cannot pull Sky Orchestrator's {release()} images: {pulled.stderr.strip()}"
            )
        self.compose("up", "--detach", "--quiet-pull", "--no-build")
        deadline = time.monotonic() + ready_within_s
        self.wait_healthy(deadline)
        self.wait_flyable(deadline)

    def services(self) -> list[str]:
        return self.compose("config", "--services").stdout.split()

    def wait_healthy(self, deadline: float) -> None:
        wanted = self.services()
        while True:
            listed = self.compose("ps", "--format", "{{.Service}}={{.Health}}").stdout.split()
            health = dict(entry.split("=", 1) for entry in listed if "=" in entry)
            if all(health.get(service) == "healthy" for service in wanted):
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"Sky Orchestrator's stack is not healthy: {health}")
            time.sleep(1)

    def status(self) -> dict[str, Any] | None:
        """so-wayline's /v1/status, or None while it does not answer."""
        request = urllib.request.Request(  # noqa: S310 - http on loopback, always
            f"{self.api_url}/v1/status", headers={"Authorization": f"Bearer {self.api_token}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - loopback http
                answered: dict[str, Any] = json.loads(response.read())
                return answered
        except urllib.error.URLError, OSError, ValueError:
            return None

    def wait_flyable(self, deadline: float) -> dict[str, Any]:
        """Until the phone's link is up, armed, with the aircraft online, in the mode asked.

        Healthy is not flyable: SO's own end to end once flew before the aircraft had a home.
        """
        while True:
            status = self.status()
            if (
                status is not None
                and (status.get("link") or {}).get("state") == "up"
                and status.get("armed") is True
                and status.get("aircraft_online") is True
                and status.get("simulator_mode") is self.simulator_mode
            ):
                return status
            if time.monotonic() > deadline:
                raise TimeoutError(f"Sky Orchestrator's stack is not ready to fly: {status}")
            time.sleep(0.5)

    def set_simulator_mode(self, simulator_mode: bool, within_s: float = 90) -> dict[str, Any]:
        """Turns the stack to simulator or real mode, the server's half of the two keys (SO's
        ADR-0040): so-bridge reads its file once at start, so it is started again on it."""
        self.simulator_mode = simulator_mode
        self.write()
        self.compose("up", "--detach", "--no-deps", "--force-recreate", "--no-build", "so-bridge")
        deadline = time.monotonic() + within_s
        self.wait_healthy(deadline)
        return self.wait_flyable(deadline)

    def set_real_launch(self, real: bool, within_s: float = 120) -> dict[str, Any]:
        """Launches the fake bridge as a phone ready for real flight, or back in its simulator,
        and turns so-bridge's simulator_mode to match, as SO's own real_launch does (DEP-28).

        so-fleet keeps running: it holds the simulation that clears a file for a real prepare
        (SO's NFR-SAF-07). The fake bridge goes first, so so-bridge links up to the application
        it will gate. so-bridge is started again only when its mode changes: starting it drops
        the link to the phone for a moment, which an operation ready to launch would see.
        """
        mode_changes = self.simulator_mode is real
        self.real_launch = real
        self.simulator_mode = not real
        self.write()
        deadline = time.monotonic() + within_s
        self.compose(
            "up", "--detach", "--no-deps", "--force-recreate", "--no-build", "fake-bridge"
        )  # fmt: skip
        self.wait_healthy(deadline)
        if mode_changes:
            self.compose(
                "up", "--detach", "--no-deps", "--force-recreate", "--no-build", "so-bridge"
            )  # fmt: skip
            self.wait_healthy(deadline)
        return self.wait_flyable(deadline)

    @property
    def gateway(self) -> str:
        """The project network's address on this host: where so-wayline's container reaches a
        server this process runs (the flight files, ADR-0008)."""
        inspected = docker(
            "network", "inspect", f"{self.project}_default",
            "--format", "{{(index .IPAM.Config 0).Gateway}}",
        )  # fmt: skip
        return inspected.stdout.strip()

    def logs(self, tail: int = 80) -> str:
        return self.compose("logs", "--no-color", "--tail", str(tail), check=False).stdout

    def stop(self) -> None:
        """Removes the project, its volumes and its files; refuses a project not its own."""
        if not self.project.startswith(PROJECT_PREFIX):
            raise ValueError(f"{self.project} is not a project this harness made")
        if (self.directory / "stack.env").exists():
            self.compose("down", "--volumes", "--remove-orphans", check=False)
        shutil.rmtree(self.directory, ignore_errors=True)


def required_variables(compose_files: Sequence[Path] = (COMPOSE, RELEASE)) -> set[str]:
    """The variables the compose files refuse to run without (`${NAME:?...}`)."""
    found: set[str] = set()
    for path in compose_files:
        found |= set(re.findall(r"\$\{([A-Z0-9_]+):\?", path.read_text(encoding="utf-8")))
    return found


__all__ = ["PROJECT_PREFIX", "Site", "SoStack", "consumer_keys", "defaults", "required_variables"]
