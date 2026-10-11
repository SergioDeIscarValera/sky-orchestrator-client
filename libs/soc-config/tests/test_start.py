from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from soc_config import ConfigurationError, Contract, start
from soc_config.contract import CONTRACT as CONTRACT_PATH

CONTRACT = Contract.read()
Written = Callable[[str], dict[str, str]]


def problems_of(consumer: str, environ: dict[str, str]) -> list[str]:
    with pytest.raises(ConfigurationError) as refusal:
        start(consumer, environ, CONTRACT)
    return refusal.value.problems


@pytest.mark.parametrize("consumer", ["soc-cloud", "soc-operations"])
def test_a_service_starts_from_its_file_and_environment(consumer: str, written: Written) -> None:
    settings = start(consumer, written(consumer), CONTRACT)
    assert settings.configuration.consumer == consumer
    assert settings.environment.port("SOC_DB_PORT") == 5432
    role = consumer.replace("-", "_").upper()
    assert settings.environment.secret(f"SOC_DB_PASSWORD_{role}").reveal()


def test_soc_cloud_gets_the_secrets_its_stacks_name(written: Written, strong: str) -> None:
    settings = start("soc-cloud", written("soc-cloud"), CONTRACT)
    assert settings.environment.secret("SOC_MQTT_PASSWORD_LAB").reveal() == strong
    assert settings.environment.secret("SOC_SO_API_TOKEN_LAB").reveal() == strong


def test_only_the_variables_of_the_service_are_read(written: Written) -> None:
    settings = start("soc-operations", written("soc-operations"), CONTRACT)
    read = {*settings.environment.values, *settings.environment.secrets}
    assert "SOC_SUPABASE_SERVICE_ROLE_KEY" not in read
    assert "SOC_DB_PASSWORD_SOC_CLOUD" not in read


@pytest.mark.parametrize(
    "variable",
    [variable.name for variable in CONTRACT.variables_of("soc-cloud")]
    + ["SOC_MQTT_PASSWORD_LAB", "SOC_SO_API_TOKEN_LAB"],
)
def test_each_variable_removed_is_named(variable: str, written: Written) -> None:
    environ = written("soc-cloud")
    del environ[variable]
    assert f"{variable} is not set" in problems_of("soc-cloud", environ)


def test_an_unreadable_file_is_named(written: Written, tmp_path: Path) -> None:
    environ = {**written("soc-cloud"), "SOC_CONFIG_FILE": str(tmp_path / "missing.json")}
    assert problems_of("soc-cloud", environ) == [
        "SOC_CONFIG_FILE cannot be read: No such file or directory"
    ]


def test_the_file_and_the_environment_are_refused_together(written: Written) -> None:
    environ = written("soc-operations")
    del environ["SOC_DB_HOST"]
    path = Path(environ["SOC_CONFIG_FILE"])
    values: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    del values["min_satellites"]
    path.write_text(json.dumps(values), encoding="utf-8")
    assert sorted(problems_of("soc-operations", environ)) == [
        '(the file): "min_satellites" is a required property',
        "SOC_DB_HOST is not set",
    ]


def test_a_consumer_without_a_configuration_file_cannot_start() -> None:
    document = json.loads(Path(CONTRACT_PATH).read_text(encoding="utf-8"))
    document["x-environment"]["SOC_CONFIG_FILE"]["x-consumers"].remove("soc-web")
    with pytest.raises(ValueError, match="soc-web"):
        start("soc-web", {}, Contract(document))


def test_the_console_has_a_configuration_file_too() -> None:
    assert problems_of("soc-web", {}) == ["SOC_CONFIG_FILE is not set"]
