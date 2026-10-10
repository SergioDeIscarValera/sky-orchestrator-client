from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import socket
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from soc_database.harness import EphemeralPostgres, docker

REALTIME_IMAGE = "supabase/realtime:v2.102.3"
TENANT = "realtime-dev"
READY_WITHIN_S = 120
TOKEN_LIFETIME_S = 3600


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


@dataclass
class RealtimeStack:
    """Postgres and Realtime as Virtual Origen runs them, on a private network.

    Realtime creates its own `realtime` schema in the database, as it does on
    the mini-PC; SOC's migrations then run against it. Realtime resolves its
    tenant from the Host header, so clients reach `realtime-dev.localhost` on
    the published port, pinned to 127.0.0.1.
    """

    network: str = field(default_factory=lambda: f"soc-rttest-{secrets.token_hex(4)}")
    jwt_secret: str = field(default_factory=lambda: secrets.token_hex(32), repr=False)
    port: int = field(default_factory=_free_port)
    postgres: EphemeralPostgres = field(init=False)

    def __post_init__(self) -> None:
        self.postgres = EphemeralPostgres(
            name=f"{self.network}-db", network=self.network, realtime_fixture=False
        )

    @property
    def realtime(self) -> str:
        return f"{self.network}-realtime"

    @property
    def host(self) -> str:
        return f"{TENANT}.localhost"

    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}/socket"

    def start(self) -> None:
        docker("network", "create", self.network)
        try:
            self.postgres.start()
            self.postgres.query(
                "create schema if not exists _realtime;"
                " alter schema _realtime owner to supabase_admin;"
            )
            self._run_realtime()
            self._wait_until(
                lambda: (
                    self.postgres.query(
                        "select to_regclass('realtime.messages') is not null", user="supabase_admin"
                    )
                    == "t"
                )
            )
            self._wait_until(self._answers)
        except BaseException:
            self.stop()
            raise

    def restart_realtime(self) -> None:
        docker("restart", self.realtime)
        self._wait_until(self._answers)

    def stop(self) -> None:
        docker("rm", "-f", self.realtime, check=False)
        self.postgres.stop()
        docker("network", "rm", self.network, check=False)

    def token(self, **claims: Any) -> str:
        body = {"iss": "supabase", "exp": int(time.time()) + TOKEN_LIFETIME_S, **claims}
        header = _base64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        payload = _base64url(json.dumps(body).encode())
        signature = hmac.digest(
            self.jwt_secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256
        )
        return f"{header}.{payload}.{_base64url(signature)}"

    def service_key(self) -> str:
        return self.token(role="service_role")

    def member_token(self, user_id: uuid.UUID) -> str:
        return self.token(sub=str(user_id), role="authenticated", aud="authenticated")

    def anonymous_token(self) -> str:
        return self.token(role="anon")

    def _run_realtime(self) -> None:
        docker(
            "run", "-d", "--name", self.realtime, "--network", self.network,
            "-p", f"127.0.0.1:{self.port}:4000",
            "-e", "PORT=4000", "-e", "DB_HOST=db", "-e", "DB_PORT=5432",
            "-e", "DB_USER=supabase_admin", "-e", f"DB_PASSWORD={self.postgres.password}",
            "-e", "DB_NAME=postgres", "-e", "DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime",
            "-e", "DB_ENC_KEY=supabaserealtime",
            "-e", f"API_JWT_SECRET={self.jwt_secret}",
            "-e", f"METRICS_JWT_SECRET={self.jwt_secret}",
            "-e", "API_JWT_JWKS=null",
            "-e", f"SECRET_KEY_BASE={secrets.token_hex(48)}",
            "-e", "ERL_AFLAGS=-proto_dist inet_tcp", "-e", "DNS_NODES=''",
            "-e", "RLIMIT_NOFILE=10000", "-e", "APP_NAME=realtime",
            "-e", "SEED_SELF_HOST=true", "-e", "RUN_JANITOR=false",
            REALTIME_IMAGE,
        )  # fmt: skip

    def _answers(self) -> bool:
        upgrade = (
            f"GET /socket/websocket?apikey={self.service_key()}&vsn=1.0.0 HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {base64.b64encode(secrets.token_bytes(16)).decode()}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=2) as connection:
                connection.sendall(upgrade.encode())
                return connection.recv(12) == b"HTTP/1.1 101"
        except OSError:
            return False

    def _wait_until(self, ready: Any) -> None:
        deadline = time.monotonic() + READY_WITHIN_S
        while time.monotonic() < deadline:
            if ready():
                return
            time.sleep(0.5)
        logs = docker("logs", "--tail", "20", self.realtime, check=False).stdout
        raise TimeoutError(f"{self.realtime} was not ready within {READY_WITHIN_S} s:\n{logs}")
