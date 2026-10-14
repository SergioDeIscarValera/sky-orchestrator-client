from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass

import msgspec

import soc_config
from soc_db import Target

SERVICE = "soc-operations"
DATABASE_ROLE = "soc_operations"


class Tunables(msgspec.Struct, frozen=True, forbid_unknown_fields=True):
    served_organizations: tuple[uuid.UUID, ...]
    telemetry_stale_after_ms: int
    telemetry_lost_after_ms: int
    stack_envelope_poll_s: int
    command_intent_ttl_s: int
    geofence_max_vertices: int
    min_satellites: int
    min_gps_quality: int
    min_battery_start_pct: int
    takeoff_tolerance_m: float
    min_arming_left_s: int
    max_arc_spacing_m: float


@dataclass(frozen=True)
class Settings:
    tunables: Tunables
    fingerprint: str
    contract_version: str
    database: Target
    health_port: int


def load(environ: Mapping[str, str] | None = None) -> Settings:
    started = soc_config.start(SERVICE, environ)
    configuration, environment = started.configuration, started.environment
    return Settings(
        tunables=msgspec.convert(configuration.values, Tunables, strict=True),
        fingerprint=configuration.fingerprint,
        contract_version=configuration.contract_version,
        database=Target(
            host=environment.text("SOC_DB_HOST"),
            port=environment.port("SOC_DB_PORT"),
            database=environment.text("SOC_DB_NAME"),
            role=DATABASE_ROLE,
            password=environment.secret("SOC_DB_PASSWORD_SOC_OPERATIONS").reveal(),
            application_name=SERVICE,
        ),
        health_port=environment.port("SOC_HEALTH_PORT"),
    )
