from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from urllib.parse import urlparse

from soc_config.contract import Variable


@dataclass(frozen=True)
class Rule:
    accepts: Callable[[str], bool]
    requirement: str
    secret: bool = False


def _matches(pattern: str) -> Callable[[str], bool]:
    compiled = re.compile(pattern)
    return lambda value: compiled.fullmatch(value) is not None


def _port(value: str) -> bool:
    return value.isascii() and value.isdigit() and 0 < int(value) < 65536


def _http_url(value: str) -> bool:
    parsed = urlparse(value)
    try:
        parsed.port  # noqa: B018
    except ValueError:
        return False
    return (
        parsed.scheme in ("http", "https")
        and bool(parsed.hostname)
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
        and not parsed.username
    )


CREDENTIAL_PATTERN = r"[A-Za-z0-9]{32,}"
JWT_PATTERN = r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
SUPABASE_KEY_PATTERN = r"sb_secret_[A-Za-z0-9_-]{20,}"

RULES: dict[str, Rule] = {
    "path": Rule(_matches(r"/[^\x00]*"), "must be an absolute path"),
    "port": Rule(_port, "must be a port number"),
    "host": Rule(
        _matches(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})"), "must be a host name or address"
    ),
    "identifier": Rule(_matches(r"[a-z_][a-z0-9_]{0,62}"), "must be a lower-case identifier"),
    "http_url": Rule(_http_url, "must be an http(s) URL with no path"),
    "secret": Rule(
        _matches(CREDENTIAL_PATTERN), "must be letters and digits only, at least 32", secret=True
    ),
    "service_key": Rule(
        _matches(f"{JWT_PATTERN}|{SUPABASE_KEY_PATTERN}"),
        "must be a service role JWT or an sb_secret_ key",
        secret=True,
    ),
}


class Secret:
    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret(********)"

    def __str__(self) -> str:
        return "********"


@dataclass(frozen=True)
class Environment:
    values: Mapping[str, str] = field(default_factory=dict)
    secrets: Mapping[str, Secret] = field(default_factory=dict)

    def text(self, name: str) -> str:
        return self.values[name]

    def port(self, name: str) -> int:
        return int(self.values[name])

    def secret(self, name: str) -> Secret:
        return self.secrets[name]

    def including(self, other: Environment) -> Environment:
        return Environment({**self.values, **other.values}, {**self.secrets, **other.secrets})


def read(
    environ: Mapping[str, str], variables: Iterable[Variable]
) -> tuple[Environment, list[str]]:
    values: dict[str, str] = {}
    secrets: dict[str, Secret] = {}
    problems: list[str] = []
    for variable in variables:
        rule = RULES[variable.rule]
        value = environ.get(variable.name, "")
        if not value:
            problems.append(f"{variable.name} is not set")
        elif not rule.accepts(value):
            problems.append(f"{variable.name} {rule.requirement}")
        elif rule.secret:
            secrets[variable.name] = Secret(value)
        else:
            values[variable.name] = value
    return Environment(values, secrets), problems
