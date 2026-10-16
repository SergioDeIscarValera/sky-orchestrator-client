#!/usr/bin/env python3
"""Deploy one version of SOC on the mini-PC, refusing while any flight is unfinished (FR-DEP-06).

Usage, from the repository checkout on the mini-PC:
    python3 infra/deploy/deploy.py v0.5.0
    python3 infra/deploy/deploy.py v0.5.0 --dry-run
    python3 infra/deploy/deploy.py v0.5.0 --ignore-flight <uuid>

The steps run in this order. The first one that fails stops the deploy and says why on
stderr; exit status 0 means every step succeeded:

1. the version is vX.Y.Z;
2. no flight is unfinished: no row of soc.flights has ended_at null. The rows come from the
   database through docker exec, and when that read fails the deploy refuses, since nothing
   then proves that no aircraft is flying;
3. SOC_VERSION in <compose-dir>/.env names the version, every other line kept byte for byte;
4. docker compose pull;
5. docker compose run --rm soc-migrate;
6. docker compose up -d --wait.

--dry-run does steps 1 and 2, checks that .env exists, and prints what steps 3 to 6 would do.
It writes nothing and runs no compose command.

Exit status: 0 when every step succeeded (or the dry run passed), 1 when refused or stopped.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

COMPOSE_DIR = Path(__file__).resolve().parents[1] / "compose"
VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+")
SOC_VERSION_LINE = re.compile(rb"[ \t]*(?:export[ \t]+)?SOC_VERSION[ \t]*=")
# One line per unfinished flight, five fields separated by '|'. translate() turns the line
# breaks and the '|' of an operation's name into spaces, so no name can break its line.
UNFINISHED_FLIGHTS = """
select f.id,
       translate(o.name, chr(10) || chr(13) || '|', '   '),
       o.state,
       f.mode,
       f.prepared_at
from soc.flights f
left join soc.operations o on o.id = f.operation_id
where f.ended_at is null
order by f.prepared_at
"""

Runner = Callable[[Sequence[str], Path], subprocess.CompletedProcess[str]]


class DeployError(Exception):
    """A step that stops the deploy. Its text is the message the operator reads on stderr."""


@dataclass(frozen=True)
class Flight:
    flight_id: str
    operation: str
    state: str
    mode: str
    prepared_at: str

    def describe(self) -> str:
        return (
            f'{self.flight_id}  {self.mode} flight of "{self.operation}" '
            f"({self.state}), prepared {self.prepared_at}"
        )


def run_command(arguments: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run one command in cwd and return its stdout. Its stderr goes to the terminal as it
    comes, so compose's progress is seen live and a database error is named where it occurs."""
    return subprocess.run(list(arguments), cwd=cwd, stdout=subprocess.PIPE, text=True, check=False)


def compose_command(*arguments: str) -> tuple[str, ...]:
    return ("docker", "compose", *arguments)


PULL = compose_command("pull")
MIGRATE = compose_command("run", "--rm", "soc-migrate")
UP = compose_command("up", "-d", "--wait")


def canonical(identifier: str) -> str | None:
    try:
        return str(uuid.UUID(identifier))
    except ValueError:
        return None


def ignored_flights(texts: Sequence[str]) -> frozenset[str]:
    identifiers: set[str] = set()
    for text in texts:
        identifier = canonical(text)
        if identifier is None:
            raise DeployError(
                f"refused: nothing was run. --ignore-flight takes a flight's UUID, not {text!r}"
            )
        identifiers.add(identifier)
    return frozenset(identifiers)


def unfinished_flights(runner: Runner, container: str, compose_dir: Path) -> list[Flight]:
    command = (
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-At",
        "-F",
        "|",
        "-c",
        UNFINISHED_FLIGHTS,
    )
    result = runner(command, compose_dir)
    if result.returncode != 0:
        raise DeployError(
            "refused: nothing was changed. The flights could not be read from "
            f"{container} (exit {result.returncode}), and nothing proves that no aircraft "
            "is flying."
        )
    return [parse_flight(line) for line in result.stdout.splitlines() if line.strip()]


def parse_flight(line: str) -> Flight:
    fields = line.split("|")
    identifier = canonical(fields[0]) if len(fields) == 5 else None
    if identifier is None:
        raise DeployError(
            "refused: nothing was changed. The flight query answered a line this command "
            f"cannot read: {line!r}"
        )
    _, operation, state, mode, prepared_at = fields
    return Flight(identifier, operation, state, mode, prepared_at)


def check_overrides(unfinished: Sequence[Flight], ignored: frozenset[str]) -> list[Flight]:
    """The unfinished flights that --ignore-flight overrides. It names every unfinished flight
    or none: anything else refuses, and so does a named id that is not an unfinished flight."""
    unknown = sorted(ignored - {flight.flight_id for flight in unfinished})
    if unknown:
        raise DeployError(
            "refused: nothing was changed. --ignore-flight names no unfinished flight: "
            + ", ".join(unknown)
        )
    left = [flight for flight in unfinished if flight.flight_id not in ignored]
    if left:
        raise DeployError(unfinished_refusal(left, partly_overridden=bool(ignored)))
    return list(unfinished)


def unfinished_refusal(flights: Sequence[Flight], *, partly_overridden: bool) -> str:
    if partly_overridden:
        head = "refused: nothing was changed. Unfinished flights not named by --ignore-flight:"
        hint = "--ignore-flight must name every unfinished flight, or none."
    else:
        head = "refused: nothing was changed. Unfinished flights:"
        hint = (
            "A flight that a fault left unended can be overridden with --ignore-flight <uuid>, "
            "once for each flight above, but only after checking on the ground that its "
            "aircraft is not flying."
        )
    return "\n".join([head, *(f"  {flight.describe()}" for flight in flights), hint])


def read_env(env: Path) -> bytes:
    try:
        return env.read_bytes()
    except OSError as error:
        raise DeployError(f"refused: nothing was changed. Cannot read {env}: {error}") from error


def previous_version(content: bytes) -> str | None:
    for line in content.splitlines():
        if SOC_VERSION_LINE.match(line):
            return line.partition(b"=")[2].strip().decode("utf-8", "replace") or None
    return None


def with_soc_version(content: bytes, version: str) -> bytes:
    """Every SOC_VERSION line names version, keeping its line ending, and the other lines stay
    as they are. A file without such a line gets one at its end, in the file's line ending."""
    newline = b"\r\n" if b"\r\n" in content else b"\n"
    assignment = f"SOC_VERSION={version}".encode()
    lines = content.splitlines(keepends=True)
    if not any(SOC_VERSION_LINE.match(line) for line in lines):
        if lines and not lines[-1].endswith((b"\n", b"\r")):
            lines[-1] += newline
        return b"".join([*lines, assignment + newline])
    rewritten: list[bytes] = []
    for line in lines:
        if SOC_VERSION_LINE.match(line):
            ending = line[len(line.rstrip(b"\r\n")) :]
            rewritten.append(assignment + ending)
        else:
            rewritten.append(line)
    return b"".join(rewritten)


def write_atomically(path: Path, content: bytes) -> None:
    """Replace path with content through a temporary file in its folder, so a failure leaves
    the old file whole. The file keeps its mode."""
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def version_note(env: Path, version: str, previous: str | None) -> str:
    return f"SOC_VERSION in {env} names {version} (it was {previous or 'not set'})"


def compose_step(
    runner: Runner, compose_dir: Path, command: tuple[str, ...], remainder: str
) -> None:
    """Run one compose command. When it fails the deploy stops, and the message tells what
    is left behind."""
    print(f"running: {shlex.join(command)}", flush=True)
    result = runner(command, compose_dir)
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        raise DeployError(
            f"stopped: `{shlex.join(command)}` exited {result.returncode}. {remainder}"
        )


def deploy(arguments: argparse.Namespace, runner: Runner) -> None:
    version: str = arguments.version
    if VERSION.fullmatch(version) is None:
        raise DeployError(
            f"refused: nothing was run. The version must look like v0.5.0, not {version!r}"
        )
    compose_dir: Path = arguments.compose_dir.resolve()
    if not compose_dir.is_dir():
        raise DeployError(f"refused: nothing was run. {compose_dir} is not a directory")
    ignored = ignored_flights(arguments.ignore_flight)

    unfinished = unfinished_flights(runner, arguments.db_container, compose_dir)
    overridden = check_overrides(unfinished, ignored)
    if overridden:
        print("warning: --ignore-flight overrides these unfinished flights:", file=sys.stderr)
        print("\n".join(f"  {flight.describe()}" for flight in overridden), file=sys.stderr)
    else:
        print("no flight is unfinished")

    env = (compose_dir / ".env").resolve()
    if not env.is_file():
        raise DeployError(
            f"refused: nothing was changed. {env} does not exist: copy .env.example to .env "
            "first (docs/mini-pc-deployment.md, step 2.3)"
        )
    content = read_env(env)
    previous = previous_version(content)

    if arguments.dry_run:
        print("dry run: nothing is written or started")
        print(f"would set SOC_VERSION={version} in {env} (it was {previous or 'not set'})")
        for command in (PULL, MIGRATE, UP):
            print(f"would run in {compose_dir}: {shlex.join(command)}")
        return

    try:
        write_atomically(env, with_soc_version(content, version))
    except OSError as error:
        raise DeployError(f"refused: nothing was changed. Cannot write {env}: {error}") from error
    state = version_note(env, version, previous)
    print(state)

    compose_step(
        runner,
        compose_dir,
        PULL,
        f"Nothing was started. {state}. Fix the cause, then run this command again.",
    )
    compose_step(
        runner,
        compose_dir,
        MIGRATE,
        "Migrations that applied stay applied, and running this command again applies only "
        f"what is pending. Nothing was started. {state}.",
    )
    compose_step(
        runner,
        compose_dir,
        UP,
        f"Some services may have changed: check `docker compose ps`. {state}.",
    )
    print(f"deployed SOC {version} from {compose_dir} (it was {previous or 'not set'})")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    command.add_argument("version", help="the release to deploy, as vX.Y.Z")
    command.add_argument(
        "--compose-dir",
        type=Path,
        default=COMPOSE_DIR,
        help="the compose project, holding .env (default: infra/compose of this checkout)",
    )
    command.add_argument(
        "--db-container",
        default="supabase-db",
        help="the container running the database that holds schema soc (default: supabase-db)",
    )
    command.add_argument(
        "--ignore-flight",
        action="append",
        default=[],
        metavar="UUID",
        help=(
            "proceed past this unfinished flight, a row a fault left unended, but only after "
            "checking on the ground that its aircraft is not flying. Name every unfinished "
            "flight or none: repeat the option for each one"
        ),
    )
    command.add_argument(
        "--dry-run",
        action="store_true",
        help="check steps 1 and 2 and print the commands of steps 3 to 6, running none of them",
    )
    return command


def main(argv: list[str] | None = None, runner: Runner = run_command) -> int:
    arguments = parser().parse_args(argv)
    try:
        deploy(arguments, runner)
    except DeployError as refusal:
        sys.stdout.flush()  # so what was printed before the refusal reads first, also in a log
        print(refusal, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
