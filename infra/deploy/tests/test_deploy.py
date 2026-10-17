from __future__ import annotations

import io
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Sequence
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import deploy

MIGRATION = Path(__file__).resolve().parents[3] / "database" / "migrations" / "0010-operations.sql"
FIRST = "3f1c2a7e-9b1d-4c55-8e0a-1d2c3b4a5f60"
SECOND = "8a0e9d4b-2f6c-4e7a-9b31-7c5d6e8f9a10"
UNKNOWN = "c0ffee00-0000-4000-8000-00000000beef"
PULL = ("docker", "compose", "pull")
MIGRATE = ("docker", "compose", "run", "--rm", "soc-migrate")
UP = ("docker", "compose", "up", "-d", "--wait")
ENV = (
    b"SOC_REGISTRY=ghcr.io/example/sky\n"
    b"SOC_VERSION=v0.4.4\n"
    b"# SOC_VERSION=v0.1.0\n"
    b"SOC_WEB_PORT=8088\n"
)
EXPECTED = ENV.replace(b"SOC_VERSION=v0.4.4\n", b"SOC_VERSION=v0.5.0\n")


def row(flight: str, state: str = "in_flight", mode: str = "real") -> str:
    return f"{flight}|Finca norte|{state}|{mode}|2026-10-17 09:12:33.123456+00\n"


def ignoring(*identifiers: str) -> list[str]:
    return [option for identifier in identifiers for option in ("--ignore-flight", identifier)]


@dataclass(frozen=True)
class Call:
    arguments: tuple[str, ...]
    cwd: Path


class Docker:
    """Records each command and answers from a script, so no docker command runs."""

    def __init__(
        self,
        flights: str | list[str] = "",
        *,
        query_status: int = 0,
        failing: str = "",
        table: str | list[str] = "t\n",
        table_status: int = 0,
    ) -> None:
        # A list answers each read in turn, its last answer from then on.
        self.flights = flights
        self.query_status = query_status
        self.failing = failing
        self.table = table
        self.table_status = table_status
        self.calls: list[Call] = []

    def __call__(self, arguments: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
        command = tuple(arguments)
        self.calls.append(Call(command, cwd))
        if command[1] == "exec" and command[-1] == deploy.FLIGHTS_TABLE:
            if isinstance(self.table, list):
                present = self.table.pop(0) if len(self.table) > 1 else self.table[0]
            else:
                present = self.table
            return subprocess.CompletedProcess(command, self.table_status, present, None)
        if command[1] == "exec":
            if isinstance(self.flights, list):
                answer = self.flights.pop(0) if len(self.flights) > 1 else self.flights[0]
            else:
                answer = self.flights
            return subprocess.CompletedProcess(command, self.query_status, answer, None)
        status = 1 if command[2] == self.failing else 0
        return subprocess.CompletedProcess(command, status, "", None)

    @property
    def compose(self) -> list[tuple[str, ...]]:
        return [call.arguments for call in self.calls if call.arguments[1] == "compose"]

    @property
    def steps(self) -> list[Call]:
        """Every call but the checks that soc.flights exists."""
        return [call for call in self.calls if call.arguments[-1] != deploy.FLIGHTS_TABLE]

    @property
    def reads(self) -> list[Call]:
        """The calls that read the flights themselves, not whether their table exists."""
        return [
            call
            for call in self.calls
            if call.arguments[1] == "exec" and call.arguments[-1] == deploy.UNFINISHED_FLIGHTS
        ]


class DeployCase(unittest.TestCase):
    def setUp(self) -> None:
        self.compose_dir = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.env = self.compose_dir / ".env"
        self.env.write_bytes(ENV)

    def deploy(self, docker: Docker, *extra: str, version: str = "v0.5.0") -> tuple[int, str, str]:
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = deploy.main(
                [version, "--compose-dir", str(self.compose_dir), *extra], runner=docker
            )
        return status, output.getvalue(), errors.getvalue()

    def files(self) -> list[str]:
        return sorted(path.name for path in self.compose_dir.iterdir())


class Version(DeployCase):
    def test_a_version_must_be_vx_y_z_and_nothing_runs(self) -> None:
        for version in ("0.5.0", "v0.5", "v0.5.0-rc1", "V0.5.0", "v0.5.0\n", "v1.2.3.4"):
            with self.subTest(version=version):
                docker = Docker()
                status, _, errors = self.deploy(docker, version=version)
                self.assertEqual(status, 1)
                self.assertEqual(docker.calls, [])
                self.assertIn("must look like v0.5.0", errors)
                self.assertEqual(self.env.read_bytes(), ENV)

    def test_a_compose_dir_that_is_not_a_folder_refuses_and_runs_nothing(self) -> None:
        docker = Docker()
        errors = io.StringIO()
        with redirect_stderr(errors):
            status = deploy.main(
                ["v0.5.0", "--compose-dir", str(self.compose_dir / "missing")], runner=docker
            )
        self.assertEqual((status, docker.calls), (1, []))
        self.assertIn("is not a directory", errors.getvalue())


class Flights(DeployCase):
    def test_an_in_flight_flight_refuses_and_changes_nothing(self) -> None:
        docker = Docker(row(FIRST))
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [])
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn(FIRST, errors)
        self.assertIn("real flight of", errors)
        self.assertIn("(in_flight)", errors)

    def test_a_failing_flight_query_refuses_and_changes_nothing(self) -> None:
        docker = Docker(query_status=2)
        status, _, errors = self.deploy(docker)
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn("nothing proves that no aircraft is flying", errors)

    def test_a_flight_query_answer_this_command_cannot_read_refuses(self) -> None:
        for flights in ("not a flight\n", "nope|Finca|in_flight|real|2026-10-17\n"):
            with self.subTest(flights=flights):
                docker = Docker(flights)
                status, _, _ = self.deploy(docker)
                self.assertEqual((status, docker.compose), (1, []))
                self.assertEqual(self.env.read_bytes(), ENV)

    def test_the_query_runs_in_the_named_container_as_postgres(self) -> None:
        docker = Docker()
        self.deploy(docker, "--db-container", "other-db")
        psql = ("docker", "exec", "other-db", "psql", "-U", "postgres", "-At", "-F", "|", "-c")
        self.assertEqual(docker.calls[0].arguments, (*psql, deploy.FLIGHTS_TABLE))
        self.assertEqual(docker.calls[1].arguments, (*psql, deploy.UNFINISHED_FLIGHTS))

    def test_the_query_reads_only_unended_flights_and_their_operations(self) -> None:
        self.assertIn("where f.ended_at is null", deploy.UNFINISHED_FLIGHTS)
        self.assertIn("on o.id = f.operation_id", deploy.UNFINISHED_FLIGHTS)

    def test_the_query_names_only_columns_the_migration_declares(self) -> None:
        text = MIGRATION.read_text(encoding="utf-8")
        tables = {"f": "flights", "o": "operations"}
        for alias, column in re.findall(r"\b([fo])\.([a-z_]+)\b", deploy.UNFINISHED_FLIGHTS):
            table = tables[alias]
            block = re.search(rf"create table soc\.{table} \((.*?)\n\);", text, re.DOTALL)
            if block is None:
                self.fail(f"the migration declares no table soc.{table}")
            with self.subTest(column=f"{table}.{column}"):
                self.assertRegex(block.group(1), rf"(?m)^  {column}\s")

    def test_an_ignored_flight_that_is_not_unfinished_refuses(self) -> None:
        docker = Docker()
        status, _, errors = self.deploy(docker, *ignoring(FIRST))
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn(FIRST, errors)

    def test_naming_every_unfinished_flight_proceeds_with_a_warning(self) -> None:
        docker = Docker(row(FIRST) + row(SECOND, state="paused", mode="simulated"))
        status, _, errors = self.deploy(docker, *ignoring(FIRST, SECOND))
        self.assertEqual(status, 0, errors)
        self.assertEqual(docker.compose, [PULL, MIGRATE, UP])
        self.assertIn("overrides these unfinished flights", errors)
        self.assertIn(FIRST, errors)
        self.assertIn(SECOND, errors)

    def test_naming_some_of_the_unfinished_flights_refuses(self) -> None:
        docker = Docker(row(FIRST) + row(SECOND))
        status, _, errors = self.deploy(docker, *ignoring(FIRST))
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn(SECOND, errors)
        self.assertIn("must name every unfinished flight, or none", errors)

    def test_naming_an_id_that_is_not_unfinished_alongside_the_others_refuses(self) -> None:
        docker = Docker(row(FIRST) + row(SECOND))
        status, _, errors = self.deploy(docker, *ignoring(FIRST, SECOND, UNKNOWN))
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn(f"names no unfinished flight: {UNKNOWN}", errors)

    def test_an_ignore_id_that_is_not_a_uuid_refuses_before_any_command(self) -> None:
        docker = Docker(row(FIRST))
        status, _, errors = self.deploy(docker, *ignoring("not-a-uuid"))
        self.assertEqual(status, 1)
        self.assertEqual(docker.calls, [])
        self.assertIn("not-a-uuid", errors)


class Environment(DeployCase):
    def test_no_unfinished_flight_sets_the_version_and_keeps_every_other_line(self) -> None:
        docker = Docker()
        status, output, errors = self.deploy(docker)
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.env.read_bytes(), EXPECTED)
        self.assertIn("deployed SOC v0.5.0", output)

    def test_the_steps_run_pull_then_migrate_then_up_in_the_compose_dir(self) -> None:
        docker = Docker()
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 0, errors)
        self.assertEqual(
            [call.arguments[1] for call in docker.steps],
            ["exec", "compose", "exec", "compose", "exec", "compose"],
        )
        self.assertEqual(docker.compose, [PULL, MIGRATE, UP])
        self.assertEqual({call.cwd for call in docker.calls}, {self.compose_dir})

    def test_a_missing_soc_version_line_is_appended(self) -> None:
        self.env.write_bytes(b"SOC_WEB_PORT=8088\n")
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.env.read_bytes(), b"SOC_WEB_PORT=8088\nSOC_VERSION=v0.5.0\n")

    def test_a_last_line_without_a_newline_gets_the_version_on_its_own_line(self) -> None:
        self.env.write_bytes(b"SOC_WEB_PORT=8088")
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.env.read_bytes(), b"SOC_WEB_PORT=8088\nSOC_VERSION=v0.5.0\n")

    def test_crlf_line_endings_are_kept(self) -> None:
        self.env.write_bytes(b"SOC_WEB_PORT=8088\r\nSOC_VERSION=v0.4.4\r\nSOC_REGISTRY=x\r\n")
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(
            self.env.read_bytes(), b"SOC_WEB_PORT=8088\r\nSOC_VERSION=v0.5.0\r\nSOC_REGISTRY=x\r\n"
        )

    def test_a_crlf_file_gets_the_appended_line_in_crlf(self) -> None:
        self.env.write_bytes(b"SOC_WEB_PORT=8088\r\n")
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.env.read_bytes(), b"SOC_WEB_PORT=8088\r\nSOC_VERSION=v0.5.0\r\n")

    def test_every_soc_version_line_names_the_version(self) -> None:
        self.env.write_bytes(b"SOC_VERSION=v0.1.0\nSOC_WEB_PORT=8088\nSOC_VERSION=v0.4.4\n")
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(
            self.env.read_bytes(), b"SOC_VERSION=v0.5.0\nSOC_WEB_PORT=8088\nSOC_VERSION=v0.5.0\n"
        )

    def test_the_file_keeps_its_mode(self) -> None:
        self.env.chmod(0o640)
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o640)

    def test_no_temporary_file_is_left_beside_it(self) -> None:
        status, _, errors = self.deploy(Docker())
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.files(), [".env"])

    def test_a_failed_write_changes_nothing_and_runs_no_compose_command(self) -> None:
        docker = Docker()
        with mock.patch.object(os, "fsync", side_effect=OSError("disk full")):
            status, _, errors = self.deploy(docker)
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertEqual(self.files(), [".env"])
        self.assertIn("disk full", errors)

    def test_a_missing_env_refuses_before_any_compose_command(self) -> None:
        self.env.unlink()
        docker = Docker()
        status, _, errors = self.deploy(docker)
        self.assertEqual((status, docker.compose), (1, []))
        self.assertIn(".env.example", errors)


class Steps(DeployCase):
    def test_a_failing_pull_stops_there_and_says_nothing_was_started(self) -> None:
        docker = Docker(failing="pull")
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL])
        self.assertIn("exited 1", errors)
        self.assertIn("Nothing was started", errors)
        self.assertIn("SOC_VERSION in", errors)

    def test_a_failing_migration_stops_before_up(self) -> None:
        docker = Docker(failing="run")
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL, MIGRATE])
        self.assertIn("applies only what is pending", errors)

    def test_a_failing_up_is_the_last_step_and_says_what_to_check(self) -> None:
        docker = Docker(failing="up")
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL, MIGRATE, UP])
        self.assertIn("docker compose ps", errors)


class DryRun(DeployCase):
    def test_the_flights_are_read_again_before_the_migration_and_before_up(self) -> None:
        docker = Docker()
        status, _, _ = self.deploy(docker)
        self.assertEqual(status, 0)
        steps = [
            call.arguments[1] if call.arguments[1] == "exec" else call.arguments
            for call in docker.steps
        ]
        self.assertEqual(steps, ["exec", PULL, "exec", MIGRATE, "exec", UP])

    def test_a_flight_that_starts_during_the_pull_stops_before_the_migration(self) -> None:
        docker = Docker(["", row(FIRST)])
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL])
        self.assertIn("a flight started during the deploy", errors)
        self.assertIn(FIRST, errors)
        self.assertIn("Nothing was migrated or restarted", errors)

    def test_a_flight_that_starts_during_the_migration_stops_before_up(self) -> None:
        docker = Docker(["", "", row(FIRST)])
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL, MIGRATE])
        self.assertIn(FIRST, errors)

    def test_a_named_flight_that_ends_during_the_deploy_does_not_stop_it(self) -> None:
        docker = Docker([row(FIRST), ""])
        status, _, _ = self.deploy(docker, *ignoring(FIRST))
        self.assertEqual(status, 0)
        self.assertEqual(docker.compose, [PULL, MIGRATE, UP])

    def test_a_flight_read_that_fails_after_the_pull_stops_before_the_migration(self) -> None:
        docker = Docker()
        original = docker.__call__

        reads = {"count": 0}

        def failing_second_read(
            arguments: Sequence[str], cwd: Path
        ) -> subprocess.CompletedProcess[str]:
            if tuple(arguments)[-1] == deploy.UNFINISHED_FLIGHTS:
                reads["count"] += 1
                if reads["count"] == 2:
                    return subprocess.CompletedProcess(tuple(arguments), 2, "", None)
            return original(arguments, cwd)

        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = deploy.main(
                ["v0.5.0", "--compose-dir", str(self.compose_dir)], runner=failing_second_read
            )
        self.assertEqual(status, 1)
        self.assertEqual(docker.compose, [PULL])
        self.assertIn("nothing proves that no aircraft is flying", errors.getvalue())

    def test_a_dry_run_writes_nothing_and_runs_no_compose_command(self) -> None:
        self.env.chmod(0o640)
        docker = Docker()
        status, output, errors = self.deploy(docker, "--dry-run")
        self.assertEqual(status, 0, errors)
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o640)
        self.assertEqual(docker.compose, [])
        self.assertEqual([call.arguments[1] for call in docker.steps], ["exec"])
        self.assertIn("would set SOC_VERSION=v0.5.0", output)
        self.assertIn("would run in", output)
        for command in ("docker compose pull", "docker compose run --rm soc-migrate"):
            self.assertIn(command, output)
        self.assertIn("docker compose up -d --wait", output)

    def test_a_dry_run_still_refuses_while_a_flight_is_unfinished(self) -> None:
        docker = Docker(row(FIRST))
        status, _, errors = self.deploy(docker, "--dry-run")
        self.assertEqual((status, docker.compose), (1, []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn(FIRST, errors)


if __name__ == "__main__":
    unittest.main()


class FirstInstall(DeployCase):
    def test_without_soc_flights_the_first_install_runs_every_step(self) -> None:
        docker = Docker(table=["f\n", "f\n", "t\n"])
        status, output, errors = self.deploy(docker)
        self.assertEqual(status, 0, errors)
        self.assertEqual(docker.compose, [PULL, MIGRATE, UP])
        self.assertIn("no flight is unfinished", output)
        # The flights themselves are read only once their table exists: before up.
        self.assertEqual(len(docker.reads), 1)

    def test_while_soc_flights_is_absent_the_flights_query_never_runs(self) -> None:
        docker = Docker(row(FIRST), table="f\n")
        status, _, errors = self.deploy(docker)
        self.assertEqual(status, 0, errors)
        self.assertEqual(docker.reads, [])

    def test_a_failing_table_check_refuses_and_changes_nothing(self) -> None:
        docker = Docker(table_status=2)
        status, _, errors = self.deploy(docker)
        self.assertEqual((status, docker.compose, docker.reads), (1, [], []))
        self.assertEqual(self.env.read_bytes(), ENV)
        self.assertIn("nothing proves that no aircraft is flying", errors)

    def test_a_table_check_answer_that_is_neither_true_nor_false_refuses(self) -> None:
        for answer in ("", "yes\n", "t\nf\n", "ERROR\n"):
            with self.subTest(answer=answer):
                docker = Docker(table=answer)
                status, _, _ = self.deploy(docker)
                self.assertEqual((status, docker.compose), (1, []))
                self.assertEqual(self.env.read_bytes(), ENV)

    def test_once_the_table_exists_an_unfinished_flight_still_refuses(self) -> None:
        docker = Docker(row(FIRST), table="t\n")
        status, _, errors = self.deploy(docker)
        self.assertEqual((status, docker.compose), (1, []))
        self.assertIn(FIRST, errors)

    def test_the_table_check_names_the_table_the_migration_creates(self) -> None:
        self.assertEqual(deploy.FLIGHTS_TABLE, "select to_regclass('soc.flights') is not null")
        self.assertIn("create table soc.flights (", MIGRATION.read_text(encoding="utf-8"))
