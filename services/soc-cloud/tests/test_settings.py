from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import msgspec
import pytest

import soc_config
from soc_cloud import settings
from soc_config import Contract

CONTRACT = Contract.read()
ORGANIZATION = "6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"
STRONG = "k" * 20 + "7" * 20
SERVICE_KEY = ".".join(("h" * 20, "p" * 40, "s" * 43))
STACK = {
    "name": "lab",
    "broker": {
        "host": "so-mosquitto",
        "port": 1883,
        "username": "cloud-client",
        "password_env": "SOC_MQTT_PASSWORD_LAB",
        "client_id": "soc-cloud-lab",
    },
    "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_LAB"},
    "flight_files_url": "http://soc-cloud:8090",
}


def fields(struct: type[msgspec.Struct]) -> set[str]:
    return set(struct.__struct_fields__)


def definition(name: str) -> set[str]:
    return set(CONTRACT.document["$defs"][name]["properties"])


@pytest.fixture
def environ(tmp_path: Path) -> dict[str, str]:
    values: dict[str, Any] = {
        **CONTRACT.starting_file(settings.SERVICE),
        "served_organizations": [ORGANIZATION],
        "stacks": [STACK],
    }
    path = tmp_path / "soc-cloud.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return {
        "SOC_CONFIG_FILE": str(path),
        "SOC_HEALTH_PORT": "8080",
        "SOC_FLIGHT_FILES_PORT": "8090",
        "SOC_DB_HOST": "db",
        "SOC_DB_PORT": "5432",
        "SOC_DB_NAME": "postgres",
        "SOC_DB_PASSWORD_SOC_CLOUD": STRONG,
        "SOC_SUPABASE_URL": "http://kong:8000",
        "SOC_SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY,
        "SOC_MQTT_PASSWORD_LAB": STRONG,
        "SOC_SO_API_TOKEN_LAB": STRONG,
    }


def test_the_service_reads_exactly_the_keys_the_contract_gives_it() -> None:
    assert fields(settings.Tunables) == set(CONTRACT.keys(settings.SERVICE))


@pytest.mark.parametrize(
    ("struct", "name"),
    [(settings.Stack, "stack"), (settings.Broker, "broker"), (settings.Api, "api")],
)
def test_each_nested_view_holds_exactly_its_definition(
    struct: type[msgspec.Struct], name: str
) -> None:
    assert fields(struct) == definition(name)


def test_a_complete_start_gives_the_typed_settings(environ: dict[str, str]) -> None:
    loaded = settings.load(environ)
    assert loaded.tunables.served_organizations == (uuid.UUID(ORGANIZATION),)
    assert loaded.tunables.stacks[0].broker.port == 1883
    assert loaded.tunables.telemetry_stale_after_ms == 3000
    assert len(loaded.fingerprint) == 64
    assert loaded.contract_version == CONTRACT.version
    assert loaded.database.role == "soc_cloud"
    assert loaded.database.application_name == "soc-cloud"
    assert loaded.realtime.base == "http://kong:8000/realtime/v1"
    assert loaded.health_port == 8080
    assert loaded.flight_files_port == 8090
    assert loaded.credentials["lab"].broker_password.reveal() == STRONG


def test_no_secret_shows_in_the_settings(environ: dict[str, str]) -> None:
    assert STRONG not in repr(settings.load(environ))
    assert SERVICE_KEY not in repr(settings.load(environ))


def test_a_missing_stack_secret_stops_the_start(environ: dict[str, str]) -> None:
    del environ["SOC_SO_API_TOKEN_LAB"]
    with pytest.raises(soc_config.ConfigurationError, match="SOC_SO_API_TOKEN_LAB is not set"):
        settings.load(environ)
