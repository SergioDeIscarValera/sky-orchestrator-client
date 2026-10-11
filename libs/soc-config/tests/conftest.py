from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from soc_config import Contract

ORGANIZATION = "6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"
STACK: dict[str, Any] = {
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
NO_DEFAULT: dict[str, Any] = {"served_organizations": [ORGANIZATION], "stacks": [STACK]}

STRONG = "k" * 20 + "7" * 20
SERVICE_KEY = ".".join(("h" * 20, "p" * 40, "s" * 43))
DEPLOYMENT = {
    "SOC_HEALTH_PORT": "8080",
    "SOC_DB_HOST": "db",
    "SOC_DB_PORT": "5432",
    "SOC_DB_NAME": "postgres",
    "SOC_DB_PASSWORD_SOC_CLOUD": STRONG,
    "SOC_DB_PASSWORD_SOC_OPERATIONS": STRONG,
    "SOC_SUPABASE_URL": "http://kong:8000",
    "SOC_SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY,
    "SOC_FLIGHT_FILES_PORT": "8090",
    "SOC_MQTT_PASSWORD_LAB": STRONG,
    "SOC_SO_API_TOKEN_LAB": STRONG,
}

Complete = Callable[..., dict[str, Any]]


@pytest.fixture(scope="session")
def contract() -> Contract:
    return Contract.read()


@pytest.fixture
def complete(contract: Contract) -> Complete:
    def build(consumer: str, **overrides: Any) -> dict[str, Any]:
        values = {
            key: copy.deepcopy(NO_DEFAULT[key]) if default is None else default
            for key, default in contract.starting_file(consumer).items()
        }
        return {**values, **overrides}

    return build


@pytest.fixture
def written(tmp_path: Path, complete: Complete) -> Callable[[str], dict[str, str]]:
    def environ(consumer: str) -> dict[str, str]:
        path = tmp_path / f"{consumer}.json"
        path.write_text(json.dumps(complete(consumer)), encoding="utf-8")
        return {**DEPLOYMENT, "SOC_CONFIG_FILE": str(path)}

    return environ


@pytest.fixture
def deployment() -> dict[str, str]:
    return dict(DEPLOYMENT)


@pytest.fixture
def stack() -> dict[str, Any]:
    return copy.deepcopy(STACK)


@pytest.fixture
def strong() -> str:
    return STRONG
