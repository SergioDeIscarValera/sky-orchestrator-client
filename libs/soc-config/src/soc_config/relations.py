from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

Values = Mapping[str, Any]


def distinct(values: Iterable[object]) -> bool:
    seen = list(values)
    return len(seen) == len(set(seen))


@dataclass(frozen=True)
class Relation:
    statement: str
    keys: frozenset[str]
    holds: Callable[[Values], bool]

    def applies_to(self, values: Values) -> bool:
        return self.keys <= values.keys()


RELATIONS = (
    Relation(
        "telemetry_stale_after_ms < telemetry_lost_after_ms",
        frozenset({"telemetry_stale_after_ms", "telemetry_lost_after_ms"}),
        lambda v: v["telemetry_stale_after_ms"] < v["telemetry_lost_after_ms"],
    ),
    Relation(
        "stack_status_poll_ms < telemetry_stale_after_ms",
        frozenset({"stack_status_poll_ms", "telemetry_stale_after_ms"}),
        lambda v: v["stack_status_poll_ms"] < v["telemetry_stale_after_ms"],
    ),
    Relation(
        "stacks[].name are distinct",
        frozenset({"stacks"}),
        lambda v: distinct(stack["name"] for stack in v["stacks"]),
    ),
    Relation(
        "stacks[].broker.client_id are distinct",
        frozenset({"stacks"}),
        lambda v: distinct(stack["broker"]["client_id"] for stack in v["stacks"]),
    ),
    Relation(
        "stacks[].organization are in served_organizations",
        frozenset({"stacks", "served_organizations"}),
        lambda v: (
            {stack["organization"] for stack in v["stacks"]} <= set(v["served_organizations"])
        ),
    ),
)


def broken(values: Values) -> list[str]:
    return [
        f"{relation.statement} does not hold"
        for relation in RELATIONS
        if relation.applies_to(values) and not relation.holds(values)
    ]
