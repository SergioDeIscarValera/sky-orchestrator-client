"""Sky Orchestrator's throwaway stack, held without Docker (soc_e2e.so_stack).

What the stack is started with is checked against the files it runs by: every variable the
vendored compose files refuse to run without is given, each service's file takes exactly its
consumer's keys in the vendored configuration contract and passes its schema, the phone's
envelope is so-wayline's, and the credentials are what SO's secrets accept.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest

from soc_e2e import so_stack
from soc_e2e.so_stack import (
    PROJECT_PREFIX,
    SECRET,
    Site,
    SoStack,
    consumer_keys,
    release,
    required_variables,
    schema,
)

FARM = Site(latitude_deg=41.6523, longitude_deg=-4.7245)
#: Each file's consumer in the contract.
CONSUMERS = {
    "so-wayline.json": "so-wayline",
    "so-bridge.json": "so-bridge",
    "so-fleet.json": "so-fleet",
    "so-gateway.json": "so-gateway",
    "fake-bridge.json": "so-msdk-v4",
}


@pytest.fixture
def stack(tmp_path: Path) -> SoStack:
    return SoStack(site=FARM, directory=tmp_path / "stack")


def validator(consumer: str) -> Any:
    """The contract's schema narrowed to one consumer's keys, every one of them required."""
    contract = schema()
    keys = consumer_keys(contract, consumer)
    narrowed = {
        **{name: value for name, value in contract.items() if name != "properties"},
        "properties": dict(keys),
        "required": sorted(keys),
        "additionalProperties": False,
    }
    narrowed.pop("x-constraints", None)
    return jsonschema_rs.validator_for(narrowed)


def test_every_variable_the_compose_files_require_is_given(stack: SoStack) -> None:
    required = required_variables()
    assert required, "the vendored compose files name no required variable"
    assert required <= set(stack.environment())


def test_the_external_role_runs_with_the_fake_bridge_and_without_the_store(
    stack: SoStack,
) -> None:
    environment = stack.environment()
    assert environment["COMPOSE_PROFILES"] == "fake-bridge"
    assert not any(name.startswith("SO_S3_") for name in environment)
    assert environment["SO_BIND"] == "127.0.0.1"
    assert environment["SO_VERSION"] == release()


@pytest.mark.parametrize("name", sorted(CONSUMERS))
def test_each_services_file_is_its_consumers_and_passes_the_contract(
    stack: SoStack, name: str
) -> None:
    written = stack.configurations()[name]
    errors = [error.message for error in validator(CONSUMERS[name]).iter_errors(written)]
    assert errors == []


def test_the_cloud_role_is_external_wherever_the_contract_has_it(stack: SoStack) -> None:
    for name, values in stack.configurations().items():
        if "cloud_role" in consumer_keys(schema(), CONSUMERS[name]):
            assert values["cloud_role"] == "external", name


def test_the_phones_envelope_is_so_waylines(stack: SoStack) -> None:
    files = stack.configurations()
    phone = consumer_keys(schema(), "so-msdk-v4")
    shared = [key for key in FARM.envelope() if key in phone]
    assert {"geofence_center", "geofence_radius_m", "max_height_m"} <= set(shared)
    for key, value in FARM.envelope().items():
        assert files["so-wayline.json"][key] == value
        if key in phone:
            assert files["fake-bridge.json"][key] == value


def test_the_fake_bridges_file_keeps_the_contracts_own_constraints(stack: SoStack) -> None:
    phone = stack.configurations()["fake-bridge.json"]
    assert (
        phone["min_battery_land_pct"]
        < phone["min_battery_rth_pct"]
        < phone["min_battery_start_pct"]
    )
    assert phone["stick_watchdog_ms"] < phone["stick_failsafe_ms"]
    assert phone["stick_watchdog_ms"] >= 2 * 1000 / phone["guidance_hz"]
    assert phone["telemetry_stale_after_ms"] <= phone["stick_failsafe_ms"]


def test_the_identities_are_the_ones_the_harness_names(stack: SoStack) -> None:
    fleet = stack.configurations()["so-fleet.json"]
    assert fleet["dock_identity"]["sn"] == stack.dock_sn
    assert fleet["aircraft_identity"]["sn"] == stack.aircraft_sn


def test_the_credentials_are_what_sky_orchestrators_secrets_accept(stack: SoStack) -> None:
    assert all(SECRET.match(value) for value in stack.credentials.values())
    assert len(set(stack.credentials.values())) == len(stack.credentials)


def test_the_fake_bridge_launches_in_its_simulator_unless_asked_for_real(
    stack: SoStack,
) -> None:
    assert stack.environment()["FAKE_BRIDGE_REAL"] == "0"
    stack.real_launch = True
    assert stack.environment()["FAKE_BRIDGE_REAL"] == "1"


def test_the_simulator_mode_is_the_stacks_own(stack: SoStack) -> None:
    assert stack.configurations()["so-bridge.json"]["simulator_mode"] is True
    stack.simulator_mode = False
    assert stack.configurations()["so-bridge.json"]["simulator_mode"] is False


def test_the_files_are_written_readable_and_the_secrets_private(stack: SoStack) -> None:
    stack.write()
    for name in CONSUMERS:
        path = stack.directory / name
        assert json.loads(path.read_text()) == stack.configurations()[name]
        assert path.stat().st_mode & 0o777 == 0o644
    env = stack.directory / "stack.env"
    assert env.stat().st_mode & 0o777 == 0o600
    assert stack.cloud_password in env.read_text()


def test_a_project_is_its_own_and_none_other_is_taken_down(stack: SoStack) -> None:
    assert stack.project.startswith(PROJECT_PREFIX)
    assert SoStack(site=FARM).project != stack.project
    stack.project = "sky-orchestrator"
    with pytest.raises(ValueError, match="not a project this harness made"):
        stack.stop()


def test_the_release_is_the_vendored_one() -> None:
    provenance = json.loads(
        (
            Path(__file__).resolve().parents[3] / "contracts/sky-orchestrator/vendored.json"
        ).read_text()
    )
    assert release() == provenance["describe"]


def test_an_image_it_cannot_pull_is_named_with_dockers_reason(
    stack: SoStack, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refused(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        assert "pull" in arguments and not check
        return subprocess.CompletedProcess(
            list(arguments), 1, "", "Error response from daemon: denied\n"
        )

    monkeypatch.setattr(so_stack, "docker", refused)
    with pytest.raises(RuntimeError, match=f"cannot pull .*{release()}.*: .*denied$"):
        stack.start()
