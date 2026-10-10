from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest

import soc_config
from soc_config import Contract
from soc_operations import settings

CONTRACT = Contract.read()
ORGANIZATION = "6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"
STRONG = "k" * 20 + "7" * 20


def write_environ(directory: Path) -> dict[str, str]:
    values: dict[str, Any] = {
        **CONTRACT.starting_file(settings.SERVICE),
        "served_organizations": [ORGANIZATION],
    }
    path = directory / "soc-operations.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return {
        "SOC_CONFIG_FILE": str(path),
        "SOC_HEALTH_PORT": "8081",
        "SOC_DB_HOST": "db",
        "SOC_DB_PORT": "5432",
        "SOC_DB_NAME": "postgres",
        "SOC_DB_PASSWORD_SOC_OPERATIONS": STRONG,
    }


def test_the_service_reads_exactly_the_keys_the_contract_gives_it() -> None:
    assert set(settings.Tunables.__struct_fields__) == set(CONTRACT.keys(settings.SERVICE))


def test_a_complete_start_gives_the_typed_settings(tmp_path: Path) -> None:
    loaded = settings.load(write_environ(tmp_path))
    assert loaded.tunables.served_organizations == (uuid.UUID(ORGANIZATION),)
    assert loaded.tunables.min_satellites == 12
    assert loaded.tunables.takeoff_tolerance_m == 10.0
    assert loaded.database.role == "soc_operations"
    assert loaded.database.application_name == "soc-operations"
    assert loaded.health_port == 8081
    assert len(loaded.fingerprint) == 64


def test_no_secret_shows_in_the_settings(tmp_path: Path) -> None:
    assert STRONG not in repr(settings.load(write_environ(tmp_path)))


@pytest.mark.parametrize("key", CONTRACT.keys(settings.SERVICE))
def test_each_key_removed_stops_the_start_naming_it(key: str, tmp_path: Path) -> None:
    environ = write_environ(tmp_path)
    path = Path(environ["SOC_CONFIG_FILE"])
    values = json.loads(path.read_text(encoding="utf-8"))
    del values[key]
    path.write_text(json.dumps(values), encoding="utf-8")
    with pytest.raises(soc_config.ConfigurationError, match=key):
        settings.load(environ)
