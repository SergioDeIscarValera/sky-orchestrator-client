from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any

CONTRACT = Path(__file__).resolve().parents[4] / "contracts" / "config" / "soc-config.schema.json"


@dataclass(frozen=True)
class Variable:
    name: str
    rule: str
    consumers: tuple[str, ...]


class Contract:
    def __init__(self, document: Mapping[str, Any]) -> None:
        self.document = document

    @classmethod
    def read(cls, path: Path = CONTRACT) -> Contract:
        return cls(json.loads(path.read_text(encoding="utf-8")))

    @property
    def version(self) -> str:
        return str(self.document["x-version"])

    @property
    def constraints(self) -> tuple[str, ...]:
        return tuple(self.document.get("x-constraints", ()))

    @cached_property
    def variables(self) -> tuple[Variable, ...]:
        return tuple(
            Variable(name, spec["rule"], tuple(spec["x-consumers"]))
            for name, spec in self.document.get("x-environment", {}).items()
        )

    @cached_property
    def consumers(self) -> tuple[str, ...]:
        named = {
            consumer
            for spec in self.document["properties"].values()
            for consumer in spec["x-consumers"]
        }
        named.update(consumer for variable in self.variables for consumer in variable.consumers)
        return tuple(sorted(named))

    def keys(self, consumer: str) -> tuple[str, ...]:
        return tuple(
            key
            for key, spec in self.document["properties"].items()
            if consumer in spec["x-consumers"]
        )

    def variables_of(self, consumer: str) -> tuple[Variable, ...]:
        return tuple(variable for variable in self.variables if consumer in variable.consumers)

    def schema(self, consumer: str) -> dict[str, Any]:
        keys = self.keys(consumer)
        if not keys:
            raise ValueError(f"no key in the contract lists {consumer!r} as a consumer")
        properties = self.document["properties"]
        return {
            "$schema": self.document["$schema"],
            "type": "object",
            "additionalProperties": False,
            "required": list(keys),
            "properties": {key: properties[key] for key in keys},
            "$defs": self.document.get("$defs", {}),
        }

    def starting_file(self, consumer: str) -> dict[str, Any]:
        properties = self.document["properties"]
        return {key: properties[key].get("default") for key in self.keys(consumer)}
