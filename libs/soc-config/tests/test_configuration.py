from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from soc_config import ConfigurationError, Contract, load

Complete = Callable[..., dict[str, Any]]

CONTRACT = Contract.read()
CONSUMERS = CONTRACT.consumers
EVERY_KEY = [(consumer, key) for consumer in CONSUMERS for key in CONTRACT.keys(consumer)]
BOUNDED = [
    (key, spec)
    for key, spec in CONTRACT.document["properties"].items()
    if "minimum" in spec and "maximum" in spec
]
RELATED_AT_ITS_LOOSEST = {
    "telemetry_stale_after_ms": {
        "telemetry_lost_after_ms": CONTRACT.document["properties"]["telemetry_lost_after_ms"][
            "maximum"
        ]
    },
    "telemetry_lost_after_ms": {
        "telemetry_stale_after_ms": CONTRACT.document["properties"]["telemetry_stale_after_ms"][
            "minimum"
        ]
    },
}


def refused(values: Any, consumer: str = "soc-cloud") -> list[str]:
    text = values if isinstance(values, str) else json.dumps(values)
    with pytest.raises(ConfigurationError) as refusal:
        load(text, consumer, CONTRACT)
    return refusal.value.problems


@pytest.mark.parametrize("consumer", CONSUMERS)
def test_a_complete_file_loads(consumer: str, complete: Complete) -> None:
    configuration = load(json.dumps(complete(consumer)), consumer, CONTRACT)
    assert dict(configuration.values) == complete(consumer)
    assert configuration.contract_version == CONTRACT.version


@pytest.mark.parametrize(("consumer", "key"), EVERY_KEY)
def test_each_key_removed_is_named(consumer: str, key: str, complete: Complete) -> None:
    values = complete(consumer)
    del values[key]
    assert refused(values, consumer) == [f'(the file): "{key}" is a required property']


def test_another_consumers_key_is_refused(complete: Complete) -> None:
    problems = refused(complete("soc-operations", stacks=[]), "soc-operations")
    assert len(problems) == 1
    assert "stacks" in problems[0]


def test_an_unknown_key_is_refused(complete: Complete) -> None:
    assert "telemetry_stale_after_s" in refused(complete("soc-cloud", telemetry_stale_after_s=3))[0]


@pytest.mark.parametrize("wrong", ["3000", True, None, [3000]])
def test_a_wrong_type_is_never_coerced(wrong: Any, complete: Complete) -> None:
    (problem,) = refused(complete("soc-cloud", telemetry_stale_after_ms=wrong))
    assert problem.startswith("telemetry_stale_after_ms: ")


def test_an_integer_written_with_a_fraction_is_refused(complete: Complete) -> None:
    text = json.dumps(complete("soc-cloud")).replace(
        '"telemetry_batch_s": 5', '"telemetry_batch_s": 5.0'
    )
    assert refused(text) == ["telemetry_batch_s: 5.0 must be written as a whole number"]


def test_a_nested_integer_written_with_a_fraction_is_refused(
    complete: Complete, stack: dict[str, Any]
) -> None:
    text = json.dumps(complete("soc-cloud", stacks=[stack])).replace("1883", "1883.0")
    assert refused(text) == ["stacks/0/broker/port: 1883.0 must be written as a whole number"]


def test_a_number_may_be_written_without_a_fraction(complete: Complete) -> None:
    configuration = load(
        json.dumps(complete("soc-cloud", geofence_warning_band_m=7)), "soc-cloud", CONTRACT
    )
    assert configuration.values["geofence_warning_band_m"] == 7


@pytest.mark.parametrize(("key", "spec"), BOUNDED)
def test_every_bound_is_enforced(key: str, spec: dict[str, Any], complete: Complete) -> None:
    consumer = spec["x-consumers"][0]
    step = 1 if spec["type"] == "integer" else 0.5
    related = RELATED_AT_ITS_LOOSEST.get(key, {})
    for value in (spec["minimum"], spec["maximum"]):
        load(json.dumps(complete(consumer, **related, **{key: value})), consumer, CONTRACT)
    for value in (spec["minimum"] - step, spec["maximum"] + step):
        (problem,) = refused(complete(consumer, **related, **{key: value}), consumer)
        assert problem.startswith(f"{key}: ")


def test_a_key_given_twice_is_refused(complete: Complete) -> None:
    text = json.dumps(complete("soc-web"))[:-1] + ', "geofence_max_vertices": 32}'
    assert refused(text, "soc-web") == ["geofence_max_vertices is given twice"]


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_numbers_json_does_not_allow_are_refused(constant: str, complete: Complete) -> None:
    text = json.dumps(complete("soc-web"))[:-1] + f', "x": {constant}}}'
    assert refused(text, "soc-web") == [f"{constant} is not a number JSON allows"]


def test_text_that_is_not_json_is_refused() -> None:
    (problem,) = refused("served_organizations = []")
    assert problem.startswith("not JSON: ")


def test_a_file_that_is_not_an_object_is_refused() -> None:
    (problem,) = refused([1, 2])
    assert problem.startswith("(the file): ")


def test_every_problem_is_reported_at_once(complete: Complete) -> None:
    values = complete("soc-cloud", telemetry_batch_s=0, broadcast_max_rate_hz=26)
    del values["stacks"]
    assert len(refused(values)) == 3


@pytest.mark.parametrize(
    "organizations", [[], ["not-a-uuid"], ["6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"] * 2]
)
def test_served_organizations_are_distinct_uuids(
    organizations: list[str], complete: Complete
) -> None:
    (problem,) = refused(complete("soc-cloud", served_organizations=organizations))
    assert problem.startswith("served_organizations")


def test_stale_must_come_before_lost(complete: Complete) -> None:
    values = complete("soc-web", telemetry_stale_after_ms=5000, telemetry_lost_after_ms=5000)
    assert refused(values, "soc-web") == [
        "telemetry_stale_after_ms < telemetry_lost_after_ms does not hold"
    ]


def test_stack_names_are_distinct(complete: Complete, stack: dict[str, Any]) -> None:
    other = {**stack, "broker": {**stack["broker"], "client_id": "soc-cloud-other"}}
    assert refused(complete("soc-cloud", stacks=[stack, other])) == [
        "stacks[].name are distinct does not hold"
    ]


def test_a_stack_flies_for_an_organization_the_service_serves(
    complete: Complete, stack: dict[str, Any]
) -> None:
    other = {**stack, "organization": "0b6d3f1e-8a2c-4e5f-9b1a-7c3d2e1f0a9b"}
    assert refused(complete("soc-cloud", stacks=[other])) == [
        "stacks[].organization are in served_organizations does not hold"
    ]


@pytest.mark.parametrize("organization", [None, "farm", 7])
def test_a_stack_names_its_organization_by_uuid(
    complete: Complete, stack: dict[str, Any], organization: Any
) -> None:
    values = {**stack, "organization": organization}
    if organization is None:
        del values["organization"]
    problems = refused(complete("soc-cloud", stacks=[values]))
    assert problems and all(problem.startswith("stacks/0") for problem in problems)


def test_broker_client_ids_are_distinct(complete: Complete, stack: dict[str, Any]) -> None:
    assert refused(complete("soc-cloud", stacks=[stack, {**stack, "name": "field"}])) == [
        "stacks[].broker.client_id are distinct does not hold"
    ]


@pytest.mark.parametrize(
    "url", ["https://soc-cloud:8090", "http://soc-cloud:8090/files", "ftp://soc-cloud"]
)
def test_flight_files_are_offered_on_plain_http_at_the_root(
    url: str, complete: Complete, stack: dict[str, Any]
) -> None:
    (problem,) = refused(complete("soc-cloud", stacks=[{**stack, "flight_files_url": url}]))
    assert problem.startswith("stacks/0/flight_files_url: ")


def test_a_secret_is_named_never_written(complete: Complete, stack: dict[str, Any]) -> None:
    broker = {**stack["broker"], "password_env": "x" * 40}
    (problem,) = refused(complete("soc-cloud", stacks=[{**stack, "broker": broker}]))
    assert problem.startswith("stacks/0/broker/password_env: ")


def test_the_secret_references_are_listed_once(complete: Complete, stack: dict[str, Any]) -> None:
    field = {
        **stack,
        "name": "field",
        "broker": {**stack["broker"], "client_id": "soc-cloud-field"},
    }
    configuration = load(
        json.dumps(complete("soc-cloud", stacks=[stack, field])), "soc-cloud", CONTRACT
    )
    assert configuration.secret_references() == ("SOC_MQTT_PASSWORD_LAB", "SOC_SO_API_TOKEN_LAB")


def test_the_fingerprint_follows_the_values_not_their_order(complete: Complete) -> None:
    values = complete("soc-web")
    reordered = dict(reversed(values.items()))
    changed = {**values, "geofence_max_vertices": 33}

    def fingerprint(value: dict[str, Any]) -> str:
        return load(json.dumps(value), "soc-web", CONTRACT).fingerprint

    assert fingerprint(values) == fingerprint(reordered)
    assert fingerprint(values) != fingerprint(changed)
    assert len(fingerprint(values)) == 64
