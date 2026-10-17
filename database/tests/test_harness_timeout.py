from __future__ import annotations

from pathlib import Path

import pytest

from soc_database import harness


@pytest.fixture
def hanging_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = tmp_path / "docker"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setattr(harness, "DOCKER", str(fake))


@pytest.mark.usefixtures("hanging_docker")
def test_a_hanging_command_fails_naming_it_and_never_its_values() -> None:
    with pytest.raises(TimeoutError, match=r"^docker exec did not finish within 0\.2 s$") as raised:
        harness.docker("exec", "-i", "-e", "PGPASSWORD=never-shown", "db", timeout_s=0.2)
    assert "never-shown" not in str(raised.value)
    assert raised.value.__suppress_context__


def test_the_default_leaves_ci_room_to_report() -> None:
    assert 60 <= harness.DOCKER_TIMEOUT_S < 30 * 60
