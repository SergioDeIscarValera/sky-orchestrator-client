"""Sky Orchestrator's DJI schemas, as vendored in contracts/sky-orchestrator/mqtt.

A message is named by its schema's path without the suffix, `sys/status_reply`,
`requests/flighttask_resource_get_reply`. Nothing SOC publishes leaves without
passing its schema (FR-LNK-10).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from functools import cached_property
from pathlib import Path
from typing import Any

import jsonschema_rs

MQTT = Path(__file__).resolve().parents[4] / "contracts" / "sky-orchestrator" / "mqtt"
SCHEMA_SUFFIX = ".schema.json"
ENVELOPE = "dji-envelope"


class WireRefusedError(Exception):
    def __init__(self, kind: str, problems: list[str]) -> None:
        super().__init__(f"{kind} refused by its schema: " + "; ".join(problems))
        self.kind = kind
        self.problems = problems


class WireContract:
    def __init__(self, root: Path = MQTT) -> None:
        self._schemas = {
            path.relative_to(root).as_posix().removesuffix(SCHEMA_SUFFIX): json.loads(
                path.read_text(encoding="utf-8")
            )
            for path in sorted(root.rglob(f"*{SCHEMA_SUFFIX}"))
        }

    @property
    def kinds(self) -> tuple[str, ...]:
        return tuple(kind for kind in self._schemas if kind != ENVELOPE)

    def problems(self, kind: str, message: Mapping[str, Any]) -> list[str]:
        return sorted(
            f"{'/'.join(str(part) for part in error.instance_path) or '(the message)'}: "
            f"{error.message}"
            for error in self._validators[kind].iter_errors(dict(message))
        )

    def check(self, kind: str, message: Mapping[str, Any]) -> None:
        found = self.problems(kind, message)
        if found:
            raise WireRefusedError(kind, found)

    @cached_property
    def _validators(self) -> dict[str, Any]:
        registry = jsonschema_rs.Registry(
            [(schema["$id"], schema) for schema in self._schemas.values()]
        )
        return {
            kind: jsonschema_rs.validator_for(schema, registry=registry, validate_formats=True)
            for kind, schema in self._schemas.items()
            if kind != ENVELOPE
        }
