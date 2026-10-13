from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass

import msgspec

import soc_config
from soc_db import Target
from soc_realtime import Endpoint

SERVICE = "soc-cloud"
DATABASE_ROLE = "soc_cloud"
REALTIME_PATH = "/realtime/v1"


class Broker(msgspec.Struct, frozen=True, forbid_unknown_fields=True):
    host: str
    port: int
    username: str
    password_env: str
    client_id: str


class Api(msgspec.Struct, frozen=True, forbid_unknown_fields=True):
    url: str
    token_env: str


class Stack(msgspec.Struct, frozen=True, forbid_unknown_fields=True):
    name: str
    organization: uuid.UUID
    broker: Broker
    api: Api
    flight_files_url: str


class Tunables(msgspec.Struct, frozen=True, forbid_unknown_fields=True):
    served_organizations: tuple[uuid.UUID, ...]
    stacks: tuple[Stack, ...]
    telemetry_stale_after_ms: int
    telemetry_lost_after_ms: int
    telemetry_batch_s: int
    command_reply_timeout_s: int
    command_intent_ttl_s: int
    geofence_warning_band_m: float
    flight_file_grace_s: int
    broadcast_max_rate_hz: int
    stack_status_poll_ms: int
    stack_envelope_poll_s: int


@dataclass(frozen=True)
class StackCredentials:
    broker_password: soc_config.Secret
    api_token: soc_config.Secret


@dataclass(frozen=True)
class Settings:
    tunables: Tunables
    fingerprint: str
    contract_version: str
    database: Target
    realtime: Endpoint
    health_port: int
    flight_files_port: int
    credentials: Mapping[str, StackCredentials]


def load(environ: Mapping[str, str] | None = None) -> Settings:
    started = soc_config.start(SERVICE, environ)
    configuration, environment = started.configuration, started.environment
    tunables = msgspec.convert(configuration.values, Tunables, strict=True)
    return Settings(
        tunables=tunables,
        fingerprint=configuration.fingerprint,
        contract_version=configuration.contract_version,
        database=Target(
            host=environment.text("SOC_DB_HOST"),
            port=environment.port("SOC_DB_PORT"),
            database=environment.text("SOC_DB_NAME"),
            role=DATABASE_ROLE,
            password=environment.secret("SOC_DB_PASSWORD_SOC_CLOUD").reveal(),
            application_name=SERVICE,
        ),
        realtime=Endpoint(
            environment.text("SOC_SUPABASE_URL").rstrip("/") + REALTIME_PATH,
            environment.secret("SOC_SUPABASE_SERVICE_ROLE_KEY").reveal(),
        ),
        health_port=environment.port("SOC_HEALTH_PORT"),
        flight_files_port=environment.port("SOC_FLIGHT_FILES_PORT"),
        credentials={
            stack.name: StackCredentials(
                broker_password=environment.secret(stack.broker.password_env),
                api_token=environment.secret(stack.api.token_env),
            )
            for stack in tunables.stacks
        },
    )
