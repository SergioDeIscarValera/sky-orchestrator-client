"""What a refusal from Sky Orchestrator is told as, by the method that drew it (results.py).

The words are contracts/results/results.json's: a pause or a resume the task's state refuses,
and a prepare the phone refuses, each named so the pilot knows what to do (FR-CMD-06, FR-OPS-09).
"""

from __future__ import annotations

import pytest

from soc_operations.results import meaning


@pytest.mark.parametrize(
    ("verb", "result", "told"),
    [
        (
            "pause",
            319046,
            "The task cannot be paused now: it is taking off, already paused, or over",
        ),
        ("recovery", 319042, "The task cannot be resumed now: it is not paused"),
        ("recovery", 319044, "There is no task to resume"),
        (
            "prepare",
            314010,
            "This file has not completed a simulation on this stack, lies outside the phone's own"
            " envelope, or asks a return height the aircraft did not take: the phone's record"
            " names which",
        ),
    ],
)
def test_a_refusal_is_told_by_the_method_that_drew_it(verb: str, result: int, told: str) -> None:
    assert meaning(verb, result, None) == told


def test_a_code_with_no_entry_under_its_method_is_told_with_its_number() -> None:
    assert meaning("pause", 319042, None) == "Sky Orchestrator refused it (319042)"
