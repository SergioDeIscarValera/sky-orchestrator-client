from __future__ import annotations

import pytest

from soc_config.contract import Variable
from soc_config.environment import RULES, Environment, Secret, read

ACCEPTED = {
    "path": ["/etc/soc/soc-cloud.json", "/"],
    "port": ["1", "5432", "65535"],
    "host": ["db", "so-mosquitto", "192.168.1.20", "kong.internal"],
    "identifier": ["postgres", "soc_db"],
    "http_url": ["http://kong:8000", "https://supabase.example.org/", "http://10.0.0.2"],
    "secret": ["a" * 32, "Ab3" * 20],
    "service_key": [
        ".".join(("h" * 20, "p" * 40, "s" * 43)),
        "sb_secret_" + "x" * 30,
    ],
}
REFUSED = {
    "path": ["etc/soc.json", "./soc.json"],
    "port": ["0", "65536", "80a", "-1", "٣"],
    "host": ["db host", "db/1", "-db"],
    "identifier": ["Postgres", "1db", "soc-db"],
    "http_url": [
        "kong:8000",
        "ftp://kong",
        "http://kong:8000/rest",
        "http://kong:port",
        "http://user@kong",
        "http://kong?x=1",
    ],
    "secret": ["a" * 31, "a" * 40 + "!", "a" * 40 + " "],
    "service_key": ["a" * 40, "h.p.s", "sb_secret_short"],
}


def test_every_rule_has_cases_both_ways() -> None:
    assert ACCEPTED.keys() == RULES.keys() == REFUSED.keys()


@pytest.mark.parametrize(("rule", "value"), [(r, v) for r, vs in ACCEPTED.items() for v in vs])
def test_a_rule_accepts(rule: str, value: str) -> None:
    assert RULES[rule].accepts(value)


@pytest.mark.parametrize(("rule", "value"), [(r, v) for r, vs in REFUSED.items() for v in vs])
def test_a_rule_refuses(rule: str, value: str) -> None:
    assert not RULES[rule].accepts(value)


def test_values_and_secrets_are_kept_apart(strong: str) -> None:
    environment, problems = read(
        {"SOC_DB_HOST": "db", "SOC_DB_PASSWORD_SOC_CLOUD": strong},
        [
            Variable("SOC_DB_HOST", "host", ("soc-cloud",)),
            Variable("SOC_DB_PASSWORD_SOC_CLOUD", "secret", ("soc-cloud",)),
        ],
    )
    assert problems == []
    assert environment.text("SOC_DB_HOST") == "db"
    assert environment.secret("SOC_DB_PASSWORD_SOC_CLOUD").reveal() == strong
    assert "SOC_DB_PASSWORD_SOC_CLOUD" not in environment.values


def test_a_secret_never_shows_itself(strong: str) -> None:
    environment = Environment(secrets={"SOC_DB_PASSWORD_SOC_CLOUD": Secret(strong)})
    for shown in (repr(environment), str(environment), f"{environment.secrets}"):
        assert strong not in shown
    assert str(Secret(strong)) == "********"


def test_every_problem_is_named_at_once() -> None:
    _, problems = read(
        {"SOC_DB_PORT": "five", "SOC_DB_HOST": ""},
        [
            Variable("SOC_DB_HOST", "host", ("soc-cloud",)),
            Variable("SOC_DB_PORT", "port", ("soc-cloud",)),
            Variable("SOC_DB_PASSWORD_SOC_CLOUD", "secret", ("soc-cloud",)),
        ],
    )
    assert problems == [
        "SOC_DB_HOST is not set",
        "SOC_DB_PORT must be a port number",
        "SOC_DB_PASSWORD_SOC_CLOUD is not set",
    ]


def test_a_port_is_read_as_a_number() -> None:
    environment, _ = read({"SOC_DB_PORT": "5432"}, [Variable("SOC_DB_PORT", "port", ())])
    assert environment.port("SOC_DB_PORT") == 5432


def test_a_refused_secret_is_not_echoed() -> None:
    weak = "weak-but-private"
    _, problems = read(
        {"SOC_DB_PASSWORD_SOC_CLOUD": weak},
        [Variable("SOC_DB_PASSWORD_SOC_CLOUD", "secret", ())],
    )
    assert problems == ["SOC_DB_PASSWORD_SOC_CLOUD must be letters and digits only, at least 32"]
    assert weak not in problems[0]
