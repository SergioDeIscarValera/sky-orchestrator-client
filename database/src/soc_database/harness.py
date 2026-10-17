from __future__ import annotations

import hashlib
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
# Longer than any pull, build or start the lanes make, shorter than CI's 30-minute job: a
# docker command that hangs fails its test, naming the command, instead of the whole job.
DOCKER_TIMEOUT_S = 600


def docker(
    *arguments: str,
    script: str | None = None,
    check: bool = True,
    timeout_s: float = DOCKER_TIMEOUT_S,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            [DOCKER, *arguments],
            input=script,
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError(
            f"{command_name(arguments)} did not finish within {timeout_s:g} s"
        ) from None
    result.stdout = result.stdout.strip()
    return result


def command_name(arguments: tuple[str, ...]) -> str:
    """docker and its subcommands, up to the first option: never the values that follow,
    which can be passwords (exec -e PGPASSWORD=...)."""
    words: list[str] = []
    for argument in arguments:
        if argument.startswith("-"):
            break
        words.append(argument)
    return " ".join(["docker", *words])


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

    async def organization(
        self,
        owner: uuid.UUID,
        name: str = "Farm",
        position: tuple[float, float] | None = None,
        timezone: str | None = None,
    ) -> uuid.UUID:
        organization_id = uuid.uuid4()
        latitude, longitude = position or (None, None)
        await self._admin.execute(
            "insert into public.organizations "
            "(id, name, owner_id, latitude, longitude, timezone) "
            "values ($1, $2, $3, $4, $5, $6)",
            organization_id,
            name,
            owner,
            latitude,
            longitude,
            timezone,
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


FARM = (-4.7245, 41.6523)
SQUARE = [[-4.7255, 41.6515], [-4.7235, 41.6515], [-4.7235, 41.6531], [-4.7255, 41.6531]]


@dataclass(frozen=True)
class Flown:
    """An operation with one assignment and one flight, and what they name."""

    organization_id: uuid.UUID
    gateway_sn: str
    aircraft_sn: str
    fleet_id: uuid.UUID
    geofence_id: uuid.UUID
    wayline_id: uuid.UUID
    operation_id: uuid.UUID
    assignment_id: uuid.UUID
    file_id: uuid.UUID
    flight_id: uuid.UUID


class Operations:
    """Operations, as the database's administrator makes them for a test: a stack with one
    aircraft, its fleet, a geofence, a wayline, an operation assigning them, a flight file
    and a flight, each through the constraints a real one passes."""

    def __init__(self, admin: asyncpg.Connection) -> None:
        self._admin = admin

    async def flown(
        self, organization_id: uuid.UUID, *, mode: str = "simulated", file: bytes = b"PK\x03\x04kmz"
    ) -> Flown:
        admin = self._admin
        gateway = f"SOTEST{secrets.token_hex(4).upper()}"
        aircraft = f"SOUAV{secrets.token_hex(4).upper()}"
        await admin.execute(
            "select soc.record_stack($1, 'lab', $2, 'connected')", gateway, organization_id
        )
        await admin.execute(
            "select soc.record_topology($1, $2::jsonb)",
            gateway,
            json.dumps(
                [{"aircraft_sn": aircraft, "domain": 0, "type": 67, "sub_type": 0, "online": True}]
            ),
        )
        model = await admin.fetchval("select model from soc.aircraft_models order by model limit 1")
        fleet_id = await admin.fetchval(
            "insert into soc.fleets"
            " (organization_id, name, model, airframe_serial, gateway_sn, aircraft_sn)"
            " values ($1, 'Norte 1', $2, '1WNBH9', $3, $4) returning id",
            organization_id, model, gateway, aircraft,
        )  # fmt: skip
        geofence_id = await admin.fetchval(
            "insert into soc.geofences (organization_id, name, polygon, max_height_m, origin)"
            " values ($1, 'Norte', $2::jsonb, 120, 'drawn') returning id",
            organization_id, json.dumps(SQUARE),
        )  # fmt: skip
        waypoints = [{"index": 0, "position": list(FARM), "height_m": 30, "actions": []}]
        wayline_id = await admin.fetchval(
            "insert into soc.waylines (organization_id, name, takeoff, default_height_m, design,"
            " waypoints, metrics, bake_version)"
            " values ($1, 'Pasillo', $2::jsonb, 30, '{}'::jsonb, $3::jsonb, $4::jsonb, '2.2.0')"
            " returning id",
            organization_id, json.dumps(list(FARM)), json.dumps(waypoints),
            json.dumps({"waypoint_count": 1, "distance_m": 0}),
        )  # fmt: skip
        operation_id = await admin.fetchval(
            "insert into soc.operations"
            " (organization_id, name, geofence_id, takeoff_security_height_m)"
            " values ($1, 'Norte', $2, 20) returning id",
            organization_id, geofence_id,
        )  # fmt: skip
        assignment_id = await admin.fetchval(
            "insert into soc.assignments"
            " (operation_id, organization_id, wayline_id, fleet_id, speed_ms)"
            " values ($1, $2, $3, $4, 5) returning id",
            operation_id, organization_id, wayline_id, fleet_id,
        )  # fmt: skip
        file_id = await admin.fetchval(
            "insert into soc.flight_files (organization_id, operation_id, wayline_id, bytes, md5,"
            " size_bytes, profile_version, token)"
            " values ($1, $2, $3, $4, $5, $6, '1.0.0', $7) returning id",
            organization_id, operation_id, wayline_id, file, hashlib.md5(file).hexdigest(),  # noqa: S324 - DJI's fingerprint
            len(file), secrets.token_hex(16),
        )  # fmt: skip
        flight_id = await admin.fetchval(
            "insert into soc.flights (organization_id, operation_id, assignment_id, fleet_id,"
            " gateway_sn, aircraft_sn, mode, file_id, geofence_snapshot, envelope_snapshot)"
            " values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb) returning id",
            organization_id, operation_id, assignment_id, fleet_id, gateway, aircraft, mode,
            file_id,
            json.dumps({"polygon": SQUARE, "max_height_m": 120}),
        )  # fmt: skip
        return Flown(
            organization_id, gateway, aircraft, fleet_id, geofence_id, wayline_id, operation_id,
            assignment_id, file_id, flight_id,
        )  # fmt: skip

    async def move(self, operation_id: uuid.UUID, *states: str) -> None:
        """Walk the operation through each state in turn, by the lifecycle's own moves."""
        for state in states:
            await self._admin.execute(
                "select soc.move_operation($1, $2::soc.operation_state, 'test', 'soc-operations')",
                operation_id, state,
            )  # fmt: skip
