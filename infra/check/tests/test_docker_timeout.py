from __future__ import annotations

from pathlib import Path

import pytest

import soc_check
from soc_check import command_name, docker


@pytest.fixture
def hanging_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = tmp_path / "docker"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setattr(soc_check, "DOCKER", str(fake))


@pytest.mark.usefixtures("hanging_docker")
def test_a_hanging_command_fails_naming_it() -> None:
    with pytest.raises(TimeoutError, match=r"^docker compose pull did not finish within 0\.2 s$"):
        docker("compose", "pull", "--quiet", timeout_s=0.2)


@pytest.mark.usefixtures("hanging_docker")
def test_a_hanging_command_never_shows_its_values() -> None:
    with pytest.raises(TimeoutError) as raised:
        docker("run", "--rm", "-e", "SOC_PASSWORD=never-shown", "image", timeout_s=0.2)
    assert "never-shown" not in str(raised.value)
    assert raised.value.__suppress_context__


def test_the_name_stops_at_the_first_option() -> None:
    assert command_name(("compose", "-p", "project", "up")) == "docker compose"
    assert command_name(("image", "inspect", "--format", "x")) == "docker image inspect"
    assert command_name(()) == "docker"


def test_the_default_leaves_ci_room_to_report() -> None:
    assert 60 <= soc_check.DOCKER_TIMEOUT_S < 30 * 60
