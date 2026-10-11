from __future__ import annotations

import re
from typing import Any

import jsonschema_rs
import pytest

from soc_config import CONFIG_FILE_VARIABLE, Contract
from soc_config.environment import RULES
from soc_config.relations import RELATIONS

CONTRACT = Contract.read()
PROPERTIES: dict[str, Any] = dict(CONTRACT.document["properties"])
SERVICES = ("soc-cloud", "soc-operations")


def test_the_contract_is_a_valid_schema() -> None:
    assert jsonschema_rs.meta.is_valid(dict(CONTRACT.document))


def test_the_version_is_semantic() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", CONTRACT.version)


def test_the_consumers_are_the_three_units() -> None:
    assert CONTRACT.consumers == ("soc-cloud", "soc-operations", "soc-web")


@pytest.mark.parametrize("key", PROPERTIES)
def test_every_key_says_what_it_is(key: str) -> None:
    spec = PROPERTIES[key]
    assert spec["x-consumers"], key
    assert set(spec["x-consumers"]) <= set(CONTRACT.consumers)
    assert spec["x-unit"]
    assert spec["description"]
    assert "type" in spec


@pytest.mark.parametrize("key", [key for key, spec in PROPERTIES.items() if "default" in spec])
def test_every_default_is_allowed_by_its_own_key(key: str) -> None:
    spec = PROPERTIES[key]
    assert jsonschema_rs.is_valid(spec, spec["default"]), key


@pytest.mark.parametrize("key", [key for key, spec in PROPERTIES.items() if "default" not in spec])
def test_a_key_without_a_default_is_a_safety_key(key: str) -> None:
    assert PROPERTIES[key].get("x-safety") is True


def test_the_relations_are_worded_exactly_as_the_contract() -> None:
    assert tuple(relation.statement for relation in RELATIONS) == CONTRACT.constraints


def test_every_relation_names_declared_keys() -> None:
    for relation in RELATIONS:
        assert relation.keys <= PROPERTIES.keys(), relation.statement


def test_every_environment_rule_exists_and_every_rule_is_used() -> None:
    used = {variable.rule for variable in CONTRACT.variables}
    assert used <= RULES.keys()
    assert RULES.keys() == used


@pytest.mark.parametrize("service", SERVICES)
def test_every_service_reads_a_configuration_file(service: str) -> None:
    assert CONFIG_FILE_VARIABLE in {variable.name for variable in CONTRACT.variables_of(service)}


@pytest.mark.parametrize("service", SERVICES)
def test_each_service_has_its_own_database_password(service: str) -> None:
    role = service.replace("-", "_").upper()
    names = {variable.name for variable in CONTRACT.variables_of(service)}
    assert {name for name in names if name.startswith("SOC_DB_PASSWORD_")} == {
        f"SOC_DB_PASSWORD_{role}"
    }


def test_the_service_key_reaches_soc_cloud_only() -> None:
    (variable,) = [v for v in CONTRACT.variables if v.name == "SOC_SUPABASE_SERVICE_ROLE_KEY"]
    assert variable.consumers == ("soc-cloud",)


def test_a_consumer_schema_holds_its_keys_all_required(contract: Contract) -> None:
    schema = contract.schema("soc-operations")
    assert schema["required"] == list(contract.keys("soc-operations"))
    assert schema["additionalProperties"] is False
    assert "stacks" not in schema["properties"]


def test_an_unknown_consumer_has_no_schema(contract: Contract) -> None:
    with pytest.raises(ValueError, match="soc-nothing"):
        contract.schema("soc-nothing")
