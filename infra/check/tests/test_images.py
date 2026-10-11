from __future__ import annotations

import json
import secrets
from pathlib import Path

import pytest

from soc_check import Image, docker
from soc_config import Contract
from soc_database.harness import MIGRATIONS, EphemeralPostgres

pytestmark = pytest.mark.lane

MEMORY_AT_REST_BYTES = 64 * 1024**2
ORGANIZATION = "6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a"


def migrate_environment(postgres: EphemeralPostgres, passwords: dict[str, str]) -> dict[str, str]:
    return {
        "SOC_MIGRATE_DSN": postgres.dsn(),
        **{f"SOC_DB_PASSWORD_{role.upper()}": value for role, value in passwords.items()},
    }


@pytest.mark.parametrize("service", ["soc-cloud", "soc-operations", "soc-migrate"])
def test_every_image_runs_as_an_unprivileged_user(service: str, images: dict[str, Image]) -> None:
    assert images[service].user() == "10001"


@pytest.mark.parametrize("service", ["soc-cloud", "soc-operations"])
def test_a_service_without_its_configuration_refuses_to_start(
    service: str, images: dict[str, Image]
) -> None:
    run = images[service].run({})
    assert run.status == 2
    (line,) = run.lines
    assert line["event"] == "configuration_refused"
    assert line["service"] == service
    assert "SOC_CONFIG_FILE is not set" in line["problems"]


def test_the_migration_image_applies_once_then_nothing(
    images: dict[str, Image], postgres: EphemeralPostgres, passwords: dict[str, str]
) -> None:
    environment = migrate_environment(postgres, passwords)
    first = images["soc-migrate"].run(environment)
    second = images["soc-migrate"].run(environment)
    applied = postgres.query("select count(*) from soc_migrations.applied", user="postgres")
    assert (first.status, second.status) == (0, 0)
    assert int(applied) == len(list(MIGRATIONS.glob("*.sql")))


@pytest.fixture
def operations_configuration(tmp_path: Path) -> Path:
    configuration = tmp_path / "soc-operations.json"
    values = {
        **Contract.read().starting_file("soc-operations"),
        "served_organizations": [ORGANIZATION],
    }
    configuration.write_text(json.dumps(values), encoding="utf-8")
    configuration.chmod(0o644)
    tmp_path.chmod(0o755)
    return configuration


async def test_soc_operations_is_healthy_read_only_within_its_memory_at_rest(
    images: dict[str, Image],
    migrated: EphemeralPostgres,
    passwords: dict[str, str],
    operations_configuration: Path,
    unused_tcp_port: int,
) -> None:
    configuration = operations_configuration
    container = images["soc-operations"].start(
        f"soc-check-{secrets.token_hex(3)}",
        {
            "SOC_CONFIG_FILE": "/etc/soc/soc-operations.json",
            "SOC_HEALTH_PORT": str(unused_tcp_port),
            "SOC_DB_HOST": "127.0.0.1",
            "SOC_DB_PORT": str(migrated.port),
            "SOC_DB_NAME": "postgres",
            "SOC_DB_PASSWORD_SOC_OPERATIONS": passwords["soc_operations"],
        },
        "-v", f"{configuration}:/etc/soc/soc-operations.json:ro",
        "--memory", "128m",
    )  # fmt: skip
    try:
        assert container.wait_until_healthy() < 60
        events = [line["event"] for line in container.logs()]
        memory = container.memory_bytes()
    finally:
        container.remove()
    assert "service_started" in events
    assert memory < MEMORY_AT_REST_BYTES, f"{memory / 1024**2:.1f} MiB at rest"


def test_the_compose_project_is_valid_with_its_example_files(tmp_path: Path) -> None:
    compose = Path(__file__).resolve().parents[2] / "compose"
    for source in compose.iterdir():
        target = tmp_path / source.name.removesuffix(".example")
        target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    for configuration in ("soc-cloud.json", "soc-operations.json", "soc-web.json"):
        (tmp_path / configuration).write_text("{}", encoding="utf-8")
    checked = docker(
        "compose", "--project-directory", str(tmp_path), "-f", str(tmp_path / "compose.yaml"),
        "config", "--quiet", check=False,
    )  # fmt: skip
    assert checked.returncode == 0, checked.stderr
