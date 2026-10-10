from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

import jsonschema_rs

from soc_config.contract import Contract
from soc_config.relations import broken

REFERENCE_SUFFIX = "_env"


class ConfigurationError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("configuration refused: " + "; ".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class Configuration:
    consumer: str
    values: Mapping[str, Any]
    fingerprint: str
    contract_version: str

    def secret_references(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(_references(self.values)))


def load(text: str, consumer: str, contract: Contract) -> Configuration:
    schema = contract.schema(consumer)
    raw = _parse(text)
    problems = [
        f"{_location(error.instance_path)}: {error.message}"
        for error in jsonschema_rs.validator_for(schema, validate_formats=True).iter_errors(raw)
    ]
    problems.extend(_fractional_whole_numbers(raw, schema, schema["$defs"], ()))
    if not problems:
        problems.extend(broken(raw))
    if problems:
        raise ConfigurationError(sorted(problems))
    canonical = json.dumps(raw, sort_keys=True, separators=(",", ":"))
    return Configuration(
        consumer=consumer,
        values=raw,
        fingerprint=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        contract_version=contract.version,
    )


def _parse(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_unique_keys, parse_constant=_no_constant)
    except json.JSONDecodeError as error:
        raise ConfigurationError([f"not JSON: {error}"]) from None


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise ConfigurationError([f"{key} is given twice"])
        seen[key] = value
    return seen


def _no_constant(name: str) -> Any:
    raise ConfigurationError([f"{name} is not a number JSON allows"])


def _location(path: Any) -> str:
    return "/".join(str(part) for part in path) or "(the file)"


def _fractional_whole_numbers(
    value: Any, schema: Mapping[str, Any], definitions: Mapping[str, Any], path: tuple[Any, ...]
) -> Iterator[str]:
    if "$ref" in schema:
        schema = definitions[schema["$ref"].removeprefix("#/$defs/")]
    match schema.get("type"):
        case "integer" if isinstance(value, float):
            yield f"{_location(path)}: {value} must be written as a whole number"
        case "object" if isinstance(value, dict):
            for key, child in schema.get("properties", {}).items():
                if key in value:
                    yield from _fractional_whole_numbers(
                        value[key], child, definitions, (*path, key)
                    )
        case "array" if isinstance(value, list) and "items" in schema:
            for index, item in enumerate(value):
                yield from _fractional_whole_numbers(
                    item, schema["items"], definitions, (*path, index)
                )


def _references(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key.endswith(REFERENCE_SUFFIX) and isinstance(child, str):
                yield child
            else:
                yield from _references(child)
    elif isinstance(value, list):
        for item in value:
            yield from _references(item)
