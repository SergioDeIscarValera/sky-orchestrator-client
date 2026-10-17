from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from soc_config import Contract
from soc_config.cli import main

CONTRACT = Contract.read()
Complete = Callable[..., dict[str, Any]]


def test_the_example_starts_from_the_defaults(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["example", "soc-operations"], CONTRACT) == 0
    assert json.loads(capsys.readouterr().out) == CONTRACT.starting_file("soc-operations")


def test_the_example_is_refused_until_its_blanks_are_filled(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    main(["example", "soc-cloud"], CONTRACT)
    path = tmp_path / "soc-cloud.json"
    path.write_text(capsys.readouterr().out, encoding="utf-8")
    assert main(["check", "soc-cloud", str(path)], CONTRACT) == 1
    refused = capsys.readouterr().err
    assert "served_organizations: null" in refused
    assert "stacks: null" in refused


def test_an_accepted_file_prints_its_fingerprint(
    tmp_path: Path, complete: Complete, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "soc-web.json"
    path.write_text(json.dumps(complete("soc-web")), encoding="utf-8")
    assert main(["check", "soc-web", str(path)], CONTRACT) == 0
    fingerprint, _, version = capsys.readouterr().out.strip().partition("  contract ")
    assert len(fingerprint) == 64
    assert version == CONTRACT.version


def test_a_missing_file_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", "soc-web", str(tmp_path / "none.json")], CONTRACT) == 1
    assert "No such file" in capsys.readouterr().err


def test_an_unknown_consumer_is_a_usage_error() -> None:
    with pytest.raises(SystemExit):
        main(["example", "soc-nothing"], CONTRACT)


EXAMPLES = Path(__file__).resolve().parents[3] / "infra" / "compose"


@pytest.mark.parametrize("consumer", ["soc-cloud", "soc-operations", "soc-web"])
def test_the_compose_folders_example_is_the_example_this_contract_prints(
    consumer: str, capsys: pytest.CaptureFixture[str]
) -> None:
    # The mini-PC starts its files from these, before it can pull an image (ADR-0026).
    assert main(["example", consumer], CONTRACT) == 0
    printed = capsys.readouterr().out
    assert (EXAMPLES / f"{consumer}.json.example").read_text(encoding="utf-8") == printed
