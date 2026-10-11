"""A service's configuration file and environment, held to the contract at start.

The file holds exactly the keys of `contracts/config/soc-config.schema.json`
whose `x-consumers` name the service, all required, no default applied, no
coercion; the environment holds exactly the variables `x-environment` names for
it, each checked by its rule. Every problem is reported at once (ADR-0019).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from soc_config import environment as _environment
from soc_config.configuration import Configuration, ConfigurationError, load
from soc_config.contract import CONTRACT, Contract, Variable
from soc_config.environment import Environment, Secret

CONFIG_FILE_VARIABLE = "SOC_CONFIG_FILE"
REFERENCE_RULE = "secret"

__all__ = [
    "CONFIG_FILE_VARIABLE",
    "CONTRACT",
    "Configuration",
    "ConfigurationError",
    "Contract",
    "Environment",
    "Secret",
    "Settings",
    "load",
    "start",
]


@dataclass(frozen=True)
class Settings:
    configuration: Configuration
    environment: Environment


def start(
    consumer: str, environ: Mapping[str, str] | None = None, contract: Contract | None = None
) -> Settings:
    contract = contract or Contract.read()
    variables = contract.variables_of(consumer)
    if CONFIG_FILE_VARIABLE not in {variable.name for variable in variables}:
        raise ValueError(f"the contract gives {consumer!r} no {CONFIG_FILE_VARIABLE}")
    environ = os.environ if environ is None else environ

    environment, problems = _environment.read(environ, variables)
    configuration = None
    if CONFIG_FILE_VARIABLE in environment.values:
        try:
            text = Path(environment.text(CONFIG_FILE_VARIABLE)).read_text(encoding="utf-8")
            configuration = load(text, consumer, contract)
        except OSError as error:
            problems.append(f"{CONFIG_FILE_VARIABLE} cannot be read: {error.strerror}")
        except ConfigurationError as refusal:
            problems.extend(refusal.problems)

    if configuration is not None:
        referenced = [
            Variable(name, REFERENCE_RULE, (consumer,))
            for name in configuration.secret_references()
        ]
        secrets, missing = _environment.read(environ, referenced)
        environment = environment.including(secrets)
        problems.extend(missing)

    if problems or configuration is None:
        raise ConfigurationError(problems)
    return Settings(configuration, environment)
