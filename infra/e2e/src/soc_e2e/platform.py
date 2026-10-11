"""Virtual Origen's platform as the console meets it, on the container lane.

Kong in front of GoTrue, PostgREST and Realtime, on Postgres: the images and the
routes Virtual Origen runs on the mini-PC, so the console's supabase-js talks to
one origin as it does there. Postgres and Realtime are `RealtimeStack`'s; this
adds the rest on its network, every service signing and checking tokens with its
one JWT secret.
"""

from __future__ import annotations

import json
import secrets
import socket
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from soc_database.harness import docker, migrate
from soc_database.realtime import RealtimeStack

GOTRUE_IMAGE = "supabase/gotrue:v2.189.0"
POSTGREST_IMAGE = "postgrest/postgrest:v14.12"
KONG_IMAGE = "kong/kong:3.9.1"
READY_WITHIN_S = 120
#: PostgREST's schemas on the mini-PC once DEP-21 has added `soc`.
SCHEMAS = "public,soc"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


def kong_configuration(auth: str, rest: str, realtime: str) -> dict[str, Any]:
    """Kong's routes as Supabase's kong.yml declares them, CORS on each, keys unchecked."""

    def service(name: str, url: str, path: str) -> dict[str, Any]:
        return {
            "name": name,
            "url": url,
            "routes": [{"name": name, "strip_path": True, "paths": [path]}],
            "plugins": [{"name": "cors"}],
        }

    return {
        "_format_version": "3.0",
        "services": [
            service("auth-v1", f"http://{auth}:9999/", "/auth/v1/"),
            service("rest-v1", f"http://{rest}:3000/", "/rest/v1/"),
            service("realtime-v1", f"http://{realtime}:4000/socket/", "/realtime/v1/"),
        ],
    }


@dataclass
class Platform:
    """Postgres, Realtime, GoTrue, PostgREST and Kong, Kong published on 127.0.0.1."""

    stack: RealtimeStack = field(default_factory=RealtimeStack)
    port: int = field(default_factory=free_port)
    _passwords: dict[str, str] = field(
        default_factory=lambda: {
            role: secrets.token_hex(24) for role in ("authenticator", "supabase_auth_admin")
        },
        repr=False,
    )
    _directory: Path = field(default_factory=lambda: Path(tempfile.mkdtemp(prefix="soc-kong-")))

    @property
    def url(self) -> str:
        """The address the console is given as its Supabase."""
        return f"http://127.0.0.1:{self.port}"

    def _name(self, service: str) -> str:
        return f"{self.stack.network}-{service}"

    async def start(self, passwords: Mapping[str, str]) -> None:
        """Starts Postgres and Realtime, migrates, then GoTrue, PostgREST and Kong.

        PostgREST reads its schemas once SOC's migrations have made `soc`. The
        harness loads GoTrue's auth helpers as supabase_admin; GoTrue, migrating,
        replaces them as supabase_auth_admin, which owns them on the mini-PC.
        """
        self.stack.start()
        try:
            await migrate(self.stack.postgres, passwords)
            for role, password in self._passwords.items():
                self.stack.postgres.query(f"alter role {role} with login password '{password}'")
            self.stack.postgres.query(
                "do $$ declare f regprocedure; begin"
                " for f in select oid::regprocedure from pg_proc"
                " where pronamespace = 'auth'::regnamespace loop"
                " execute format('alter function %s owner to supabase_auth_admin', f);"
                " end loop; end $$"
            )
            self._run_gotrue()
            self._run_postgrest()
            self._run_kong()
            self._wait_until(lambda: self._answers("/auth/v1/health"), "GoTrue")
            self._wait_until(lambda: self._answers("/rest/v1/"), "PostgREST")
        except BaseException:
            self.stop()
            raise

    def stop(self) -> None:
        for service in ("kong", "rest", "auth"):
            docker("rm", "-f", self._name(service), check=False)
        self.stack.stop()

    def anon_key(self) -> str:
        return self.stack.anonymous_token()

    def service_key(self) -> str:
        return self.stack.service_key()

    def create_user(self, email: str, password: str) -> uuid.UUID:
        """A confirmed user, through GoTrue's admin API, as Virtual Origen invites one."""
        body = json.dumps({"email": email, "password": password, "email_confirm": True})
        request = urllib.request.Request(  # noqa: S310 - the platform's own address
            f"{self.url}/auth/v1/admin/users",
            data=body.encode(),
            method="POST",
            headers={
                "apikey": self.service_key(),
                "authorization": f"Bearer {self.service_key()}",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as answer:  # noqa: S310
            return uuid.UUID(json.loads(answer.read())["id"])

    def _run_gotrue(self) -> None:
        database = (
            f"postgres://supabase_auth_admin:{self._passwords['supabase_auth_admin']}"
            "@db:5432/postgres"
        )
        docker(
            "run", "-d", "--name", self._name("auth"), "--network", self.stack.network,
            "-e", "GOTRUE_API_HOST=0.0.0.0", "-e", "GOTRUE_API_PORT=9999",
            "-e", f"API_EXTERNAL_URL={self.url}",
            "-e", "GOTRUE_DB_DRIVER=postgres", "-e", f"GOTRUE_DB_DATABASE_URL={database}",
            "-e", "GOTRUE_SITE_URL=http://127.0.0.1",
            "-e", f"GOTRUE_JWT_SECRET={self.stack.jwt_secret}", "-e", "GOTRUE_JWT_EXP=3600",
            "-e", "GOTRUE_JWT_AUD=authenticated",
            "-e", "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
            "-e", "GOTRUE_JWT_ADMIN_ROLES=service_role",
            "-e", "GOTRUE_DISABLE_SIGNUP=true", "-e", "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
            "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
            GOTRUE_IMAGE,
        )  # fmt: skip

    def _run_postgrest(self) -> None:
        database = f"postgres://authenticator:{self._passwords['authenticator']}@db:5432/postgres"
        docker(
            "run", "-d", "--name", self._name("rest"), "--network", self.stack.network,
            "-e", f"PGRST_DB_URI={database}", "-e", f"PGRST_DB_SCHEMAS={SCHEMAS}",
            "-e", "PGRST_DB_ANON_ROLE=anon", "-e", f"PGRST_JWT_SECRET={self.stack.jwt_secret}",
            "-e", "PGRST_DB_USE_LEGACY_GUCS=false",
            POSTGREST_IMAGE,
        )  # fmt: skip

    def _run_kong(self) -> None:
        declared = self._directory / "kong.yml"
        configuration = kong_configuration(
            self._name("auth"), self._name("rest"), self.stack.tenant_host
        )
        # JSON is YAML: Kong reads it as its declarative configuration.
        declared.write_text(json.dumps(configuration, indent=2), encoding="utf-8")
        declared.chmod(0o644)
        self._directory.chmod(0o755)
        docker(
            "run", "-d", "--name", self._name("kong"), "--network", self.stack.network,
            "-p", f"127.0.0.1:{self.port}:8000",
            "-v", f"{declared}:/home/kong/kong.yml:ro",
            "-e", "KONG_DATABASE=off", "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
            "-e", "KONG_DNS_ORDER=LAST,A,CNAME", "-e", "KONG_PLUGINS=cors",
            "-e", "KONG_NGINX_PROXY_PROXY_BUFFER_SIZE=160k",
            "-e", "KONG_NGINX_PROXY_PROXY_BUFFERS=64 160k",
            KONG_IMAGE,
        )  # fmt: skip

    def _answers(self, path: str) -> bool:
        request = urllib.request.Request(  # noqa: S310 - the platform's own address
            f"{self.url}{path}", headers={"apikey": self.anon_key()}
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as answer:  # noqa: S310
                return bool(answer.status == 200)
        except urllib.error.URLError, ConnectionError, TimeoutError:
            return False

    def _wait_until(self, ready: Any, what: str) -> None:
        deadline = time.monotonic() + READY_WITHIN_S
        while time.monotonic() < deadline:
            if ready():
                return
            time.sleep(0.5)
        logs = {
            service: docker("logs", "--tail", "15", self._name(service), check=False).stderr
            for service in ("auth", "rest", "kong")
        }
        raise TimeoutError(f"{what} did not answer through Kong within {READY_WITHIN_S} s: {logs}")
