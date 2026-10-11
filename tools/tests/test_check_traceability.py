from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_traceability as ct

FUNCTIONAL = """# Functional requirements

### FR-TEL-01 — Live telemetry · MUST
Text.

### FR-TEL-02 — Age is always visible · SHOULD
Text.
"""

NON_FUNCTIONAL = """# Non-functional requirements

### NFR-PERF-01 — Telemetry delivery · MUST
Text.
"""

MATRIX_HEADER = (
    "| ID | Priority | Unit | Milestone | Test | Status |\n| --- | --- | --- | --- | --- | --- |\n"
)


class Repository:
    def __init__(self, matrix_rows: str) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        documents = self.root / "docs" / "requirements"
        documents.mkdir(parents=True)
        (documents / "functional-requirements.md").write_text(FUNCTIONAL, encoding="utf-8")
        (documents / "non-functional-requirements.md").write_text(NON_FUNCTIONAL, encoding="utf-8")
        (documents / "traceability.md").write_text(MATRIX_HEADER + matrix_rows, encoding="utf-8")

    def problems(self) -> list[str]:
        return ct.disagreements(ct.requirements_in(self.root), ct.rows_in(self.root))

    def close(self) -> None:
        self.directory.cleanup()


def row(identifier: str, priority: str = "MUST") -> str:
    return f"| {identifier} | {priority} | soc-cloud | M2 | — | Planned |\n"


class Agreement(unittest.TestCase):
    def check(self, rows: str) -> list[str]:
        repository = Repository(rows)
        self.addCleanup(repository.close)
        return repository.problems()

    def test_a_complete_matrix_agrees(self) -> None:
        rows = row("FR-TEL-01") + row("FR-TEL-02", "SHOULD") + row("NFR-PERF-01")
        self.assertEqual(self.check(rows), [])

    def test_a_requirement_without_a_row(self) -> None:
        problems = self.check(row("FR-TEL-01") + row("NFR-PERF-01"))
        self.assertEqual(problems, ["FR-TEL-02 has no row in the matrix"])

    def test_a_row_without_a_requirement(self) -> None:
        rows = row("FR-TEL-01") + row("FR-TEL-02", "SHOULD") + row("NFR-PERF-01") + row("FR-TEL-09")
        self.assertEqual(self.check(rows), ["FR-TEL-09 in the matrix is not a requirement"])

    def test_a_duplicated_row(self) -> None:
        rows = row("FR-TEL-01") * 2 + row("FR-TEL-02", "SHOULD") + row("NFR-PERF-01")
        self.assertEqual(self.check(rows), ["FR-TEL-01 has 2 rows in the matrix"])

    def test_a_priority_that_disagrees(self) -> None:
        rows = row("FR-TEL-01") + row("FR-TEL-02", "MUST") + row("NFR-PERF-01")
        self.assertEqual(self.check(rows), ["FR-TEL-02 is SHOULD but its row says MUST"])


class Skeleton(unittest.TestCase):
    def test_rows_are_printed_for_untraced_requirements_only(self) -> None:
        repository = Repository(row("FR-TEL-01"))
        self.addCleanup(repository.close)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(ct.main([str(repository.root), "--skeleton"]), 0)
        printed = output.getvalue().splitlines()
        self.assertEqual(
            [line.split(" | ")[0] for line in printed], ["| FR-TEL-02", "| NFR-PERF-01"]
        )


class CommandLine(unittest.TestCase):
    def test_exit_status_follows_the_agreement(self) -> None:
        complete = Repository(row("FR-TEL-01") + row("FR-TEL-02", "SHOULD") + row("NFR-PERF-01"))
        partial = Repository(row("FR-TEL-01"))
        self.addCleanup(complete.close)
        self.addCleanup(partial.close)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(ct.main([str(complete.root)]), 0)
            self.assertEqual(ct.main([str(partial.root)]), 1)


if __name__ == "__main__":
    unittest.main()
