from __future__ import annotations

import json
import secrets
import shutil
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import asyncpg

from soc_migrate.migrations import discover
from soc_migrate.roles import SERVICE_ROLES, ServiceCredential
from soc_migrate.runner import Runner

DATABASE = Path(__file__).resolve().parents[2]
FIXTURES = DATABASE / "fixtures"
MIGRATIONS = DATABASE / "migrations"
IMAGE = "supabase/postgres:17.6.1.136"
READY_WITHIN_S = 120
READY_QUERY = "select count(*) from pg_roles where rolname = 'authenticated'"
DOCKER = shutil.which("docker") or "docker"


def docker(
    *arguments: str, script: str | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [DOCKER, *arguments], input=script, capture_output=True, text=True, check=check
    )
    result.stdout = result.stdout.strip()
    return result


def service_passwords() -> dict[str, str]:
    return {role: secrets.token_hex(20) for role in SERVICE_ROLES}


async def migrate(postgres: EphemeralPostgres, passwords: Mapping[str, str]) -> None:
    connection = await postgres.connect()
    try:
        credentials = [ServiceCredential(role, value) for role, value in passwords.items()]
        await Runner(connection).run(discover(MIGRATIONS), credentials)
    finally:
        await connection.close()


@dataclass
class EphemeralPostgres:
    name: str = field(default_factory=lambda: f"soc-dbtest-{secrets.token_hex(4)}")
    password: str = field(default_factory=lambda: secrets.token_hex(24), repr=False)
    port: int = 0
    network: str | None = None
    realtime_fixture: bool = True

    def start(self) -> None:
        on_network = ("--network", self.network, "--network-alias", "db") if self.network else ()
        docker(
            "run", "-d", "--rm", "--name", self.name, *on_network,
            "-p", "127.0.0.1::5432",
            "-e", f"POSTGRES_PASSWORD={self.password}",
            "-e", f"JWT_SECRET={secrets.token_hex(32)}",
            "-e", "JWT_EXP=3600",
            IMAGE,
        )  # fmt: skip
        self.port = int(docker("port", self.name, "5432/tcp").stdout.split(":")[-1])
        self._wait_until_ready()
        self._load(FIXTURES / "auth-functions.sql", user="supabase_admin")
        if self.realtime_fixture:
            self._load(FIXTURES / "realtime-schema.sql", user="supabase_admin")
        self._load(FIXTURES / "vo2-contract.sql", user="postgres")

    def stop(self) -> None:
        docker("rm", "-f", self.name, check=False)

    def query(self, sql: str, user: str = "supabase_admin") -> str:
        return self._psql(user, "-Atqc", sql).stdout

    def dsn(self, user: str = "postgres", password: str | None = None) -> str:
        return f"postgresql://{user}:{password or self.password}@127.0.0.1:{self.port}/postgres"

    async def connect(
        self, user: str = "postgres", password: str | None = None
    ) -> asyncpg.Connection:
        return await asyncpg.connect(self.dsn(user, password))

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + READY_WITHIN_S
        while time.monotonic() < deadline:
            probe = self._psql("supabase_admin", "-Atc", READY_QUERY, check=False)
            if probe.returncode == 0 and probe.stdout.strip() == "1":
                time.sleep(2)
                return
            time.sleep(1)
        raise TimeoutError(f"{self.name} was not ready within {READY_WITHIN_S} s")

    def _load(self, script: Path, *, user: str) -> None:
        self._psql(user, "-q", "-v", "ON_ERROR_STOP=1", script=script.read_text(encoding="utf-8"))

    def _psql(
        self, user: str, *arguments: str, script: str | None = None, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return docker(
            "exec", "-i", "-e", f"PGPASSWORD={self.password}", self.name,
            "psql", "-h", "localhost", "-U", user, "-d", "postgres", *arguments,
            script=script, check=check,
        )  # fmt: skip


@dataclass(frozen=True)
class Member:
    user_id: uuid.UUID
    organization_id: uuid.UUID


class Tenancy:
    def __init__(self, admin: asyncpg.Connection) -> None:
        self._admin = admin

    async def user(self) -> uuid.UUID:
        user_id = uuid.uuid4()
        await self._admin.execute(
            "insert into auth.users (id, email) values ($1, $2)", user_id, f"{user_id}@soc.test"
        )
        await self._admin.execute(
            "insert into public.profiles (id, display_name, email) values ($1, 'Test', $2)",
            user_id,
            f"{user_id}@soc.test",
        )
        return user_id

    async def organization(self, owner: uuid.UUID) -> uuid.UUID:
        organization_id = uuid.uuid4()
        await self._admin.execute(
            "insert into public.organizations (id, name, owner_id) values ($1, 'Farm', $2)",
            organization_id,
            owner,
        )
        await self.join(owner, organization_id, "owner")
        return organization_id

    async def join(self, user_id: uuid.UUID, organization_id: uuid.UUID, role: str) -> None:
        await self._admin.execute(
            "insert into public.memberships (organization_id, profile_id, role) "
            "values ($1, $2, $3)",
            organization_id,
            user_id,
            role,
        )

    async def member(self, role: str = "owner") -> Member:
        owner = await self.user()
        organization_id = await self.organization(owner)
        if role == "owner":
            return Member(owner, organization_id)
        user_id = await self.user()
        await self.join(user_id, organization_id, role)
        return Member(user_id, organization_id)

    async def soft_delete_organization(self, organization_id: uuid.UUID) -> None:
        await self._admin.execute(
            "update public.organizations set deleted_at = now() where id = $1", organization_id
        )

    async def soft_delete_membership(self, member: Member) -> None:
        await self._admin.execute(
            "update public.memberships set deleted_at = now() "
            "where organization_id = $1 and profile_id = $2",
            member.organization_id,
            member.user_id,
        )


async def impersonate(
    connection: asyncpg.Connection, user_id: uuid.UUID | None, *, topic: str | None = None
) -> None:
    role = "anon" if user_id is None else "authenticated"
    claims = {"role": role} if user_id is None else {"sub": str(user_id), "role": role}
    await connection.execute(f"set local role {role}")
    await connection.execute(
        "select set_config('request.jwt.claims', $1, true)", json.dumps(claims)
    )
    if topic is not None:
        await connection.execute("select set_config('realtime.topic', $1, true)", topic)


@asynccontextmanager
async def acting_as(
    connection: asyncpg.Connection, user_id: uuid.UUID | None, *, topic: str | None = None
) -> AsyncIterator[asyncpg.Connection]:
    transaction = connection.transaction()
    await transaction.start()
    try:
        await impersonate(connection, user_id, topic=topic)
        yield connection
    finally:
        await transaction.rollback()
