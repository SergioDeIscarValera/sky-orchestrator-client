"""SOC's images, built from the repository and run as the mini-PC runs them.

`Image` builds one service's image from its Dockerfile and runs containers of
it read-only, as user 10001, on the host network unless a test needs a
published port, and reads back
what the stack check needs: the exit status, the log lines, the health, the
memory at rest.
"""

from __future__ import annotations

import json
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
DOCKER = shutil.which("docker") or "docker"
DOCKERFILES = {
    "soc-cloud": "services/soc-cloud/Dockerfile",
    "soc-operations": "services/soc-operations/Dockerfile",
    "soc-migrate": "infra/migrate/Dockerfile",
    "soc-web": "apps/soc-web/Dockerfile",
}
HEALTHY_WITHIN_S = 60


def docker(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run([DOCKER, *arguments], capture_output=True, text=True, check=check)


@dataclass(frozen=True)
class Run:
    status: int
    lines: list[dict[str, Any]]


@dataclass
class Image:
    service: str
    tag: str = field(default_factory=lambda: f"soc-check-{secrets.token_hex(3)}")

    @property
    def reference(self) -> str:
        return f"soc-check/{self.service}:{self.tag}"

    def build(self) -> None:
        docker("build", "-q", "-f", DOCKERFILES[self.service], "-t", self.reference, str(ROOT))

    def remove(self) -> None:
        docker("rmi", "-f", self.reference, check=False)

    def user(self) -> str:
        return docker(
            "image", "inspect", "--format", "{{.Config.User}}", self.reference
        ).stdout.strip()

    def run(self, environment: dict[str, str], *options: str, network: str = "host") -> Run:
        done = docker(
            "run", "--rm", "--read-only", "--network", network,
            *_environment(environment), *options, self.reference,
            check=False,
        )  # fmt: skip
        return Run(done.returncode, _json_lines(done.stdout))

    def start(
        self, name: str, environment: dict[str, str], *options: str, network: str = "host"
    ) -> Container:
        docker(
            "run", "-d", "--name", name, "--read-only", "--network", network,
            *_environment(environment), *options, self.reference,
        )  # fmt: skip
        return Container(name)


@dataclass(frozen=True)
class Container:
    name: str

    def health(self) -> str:
        return docker("inspect", "--format", "{{.State.Health.Status}}", self.name).stdout.strip()

    def wait_until_healthy(self, within_s: float = HEALTHY_WITHIN_S) -> float:
        started = time.monotonic()
        while time.monotonic() - started < within_s:
            if self.health() == "healthy":
                return time.monotonic() - started
            time.sleep(0.5)
        raise TimeoutError(f"{self.name} was not healthy within {within_s} s: {self.logs()[-5:]}")

    def memory_bytes(self) -> int:
        usage = docker("stats", "--no-stream", "--format", "{{json .}}", self.name).stdout
        return _bytes(json.loads(usage)["MemUsage"].split("/")[0].strip())

    def logs(self) -> list[dict[str, Any]]:
        return _json_lines(docker("logs", self.name).stdout)

    def remove(self) -> None:
        docker("rm", "-f", self.name, check=False)


def _environment(environment: dict[str, str]) -> list[str]:
    return [item for name, value in environment.items() for item in ("-e", f"{name}={value}")]


def _json_lines(text: str) -> list[dict[str, Any]]:
    lines = []
    for line in text.splitlines():
        if line.startswith("{"):
            lines.append(json.loads(line))
    return lines


UNITS = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "kB": 1000, "MB": 1000**2}


def _bytes(text: str) -> int:
    for unit in sorted(UNITS, key=len, reverse=True):
        if text.endswith(unit):
            return int(float(text.removesuffix(unit)) * UNITS[unit])
    raise ValueError(f"not a size: {text}")
