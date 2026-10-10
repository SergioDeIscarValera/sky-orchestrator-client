from __future__ import annotations

import json
import re
import tomllib
import unittest
from pathlib import Path
from typing import Any

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
RULESETS = WORKFLOWS.parent / "rulesets"
REPOSITORY = WORKFLOWS.parents[1]
LANE_STEP = "- name: Container lane against Postgres, Realtime and Mosquitto"
LANE_ONLY_UNITS = ("database",)
SPLIT_BY_MARKER_UNITS = (
    "libs/soc-db",
    "libs/soc-realtime",
    "services/soc-cloud",
    "services/soc-operations",
)
NOT_IN_THE_LANE = '-m "not lane"'


def read(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def indentation(line: str) -> int:
    return len(line) - len(line.lstrip())


def block(text: str, key: str, indent: int = 0) -> list[str]:
    lines = text.splitlines()
    prefix = " " * indent + key + ":"
    starts = [index for index, line in enumerate(lines) if line.startswith(prefix)]
    if not starts:
        return []
    body: list[str] = []
    for line in lines[starts[0] + 1 :]:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and indentation(line) <= indent:
            break
        body.append(line)
    return body


def run_scripts(text: str) -> list[str]:
    lines = text.splitlines()
    scripts: list[str] = []
    for index, line in enumerate(lines):
        stripped = line.strip().removeprefix("- ")
        if not stripped.startswith("run:"):
            continue
        inline = stripped[len("run:") :].strip()
        if inline and inline not in ("|", ">"):
            scripts.append(inline)
            continue
        body = []
        for following in lines[index + 1 :]:
            if following.strip() and indentation(following) <= indentation(line):
                break
            body.append(following)
        scripts.append("\n".join(body))
    return scripts


def child_keys(lines: list[str], indent: int) -> list[str]:
    return [
        line.strip().split(":", 1)[0]
        for line in lines
        if line.strip()
        and not line.lstrip().startswith(("#", "-"))
        and indentation(line) == indent
        and ":" in line
    ]


class Helpers(unittest.TestCase):
    SAMPLE = (
        "on:\n  pull_request:\n    branches: [main]\n# note\n"
        "jobs:\n  a:\n    x: 1\n  b:\n    y: 2\n"
    )

    def test_child_keys_of_a_block(self) -> None:
        self.assertEqual(child_keys(block(self.SAMPLE, "jobs"), 2), ["a", "b"])

    def test_a_block_ends_at_the_next_top_level_key(self) -> None:
        self.assertEqual(child_keys(block(self.SAMPLE, "on"), 2), ["pull_request"])

    def test_a_missing_key_is_empty(self) -> None:
        self.assertEqual(block(self.SAMPLE, "permissions"), [])

    def test_run_scripts_inline_and_as_blocks(self) -> None:
        text = (
            "steps:\n  - run: echo one\n  - run: |\n      echo two\n      echo three\n  - name: x\n"
        )
        self.assertEqual(run_scripts(text), ["echo one", "      echo two\n      echo three"])


class EveryWorkflow(unittest.TestCase):
    def test_every_job_has_a_timeout(self) -> None:
        for workflow in sorted(WORKFLOWS.glob("*.yml")):
            text = workflow.read_text(encoding="utf-8")
            jobs = child_keys(block(text, "jobs"), 2)
            with self.subTest(workflow=workflow.name):
                self.assertEqual(text.count("timeout-minutes:"), len(jobs))

    def test_every_action_is_pinned_to_a_released_version(self) -> None:
        for workflow in sorted(WORKFLOWS.glob("*.yml")):
            for reference in re.findall(r"uses: (\S+)", workflow.read_text(encoding="utf-8")):
                with self.subTest(workflow=workflow.name, reference=reference):
                    self.assertRegex(reference, r"@v\d+(\.\d+){0,2}$")


class ContinuousIntegration(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("ci.yml")

    def test_one_job_named_gate(self) -> None:
        self.assertEqual(child_keys(block(self.text, "jobs"), 2), ["gate"])
        self.assertIn("    name: Gate\n", self.text)

    def test_pull_requests_and_manual_runs_only(self) -> None:
        self.assertEqual(
            child_keys(block(self.text, "on"), 2), ["pull_request", "workflow_dispatch"]
        )

    def test_every_check_is_present(self) -> None:
        checks = (
            "tools/check_links.py",
            "tools/check_traceability.py",
            "tools/vendor_sky_orchestrator.py --check",
            "-size +512k",
            "unittest discover -s tools/tests",
            "uv sync --frozen --all-packages",
            "uv run --frozen ruff check\n",
            "uv run --frozen ruff format --check\n",
            "mypy --python-version 3.12 tools",
            "pytest infra/migrate/tests",
            "pytest database/tests",
            "gitleaks detect",
        )
        for check in checks:
            with self.subTest(check=check):
                self.assertIn(check, self.text)

    def test_every_step_after_the_setup_reports_independently(self) -> None:
        steps = re.split(r"^      - ", self.text, flags=re.MULTILINE)[1:]
        unguarded = [step.splitlines()[0] for step in steps if "!cancelled()" not in step]
        self.assertEqual(unguarded, ["id: checkout", "id: python"])

    def test_the_database_lane_runs_only_when_what_it_tests_changes(self) -> None:
        step = self.text[self.text.index(LANE_STEP) :]
        self.assertIn("steps.lane-changes.outputs.changed == 'true'", step.splitlines()[1])


class PullRequestPolicy(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("pr-policy.yml")

    def test_one_job(self) -> None:
        self.assertEqual(child_keys(block(self.text, "jobs"), 2), ["policy"])

    def test_labelling_cannot_fail_the_policy(self) -> None:
        self.assertIn("continue-on-error: true", self.text)

    def test_repository_scripts_do_not_get_the_write_token(self) -> None:
        self.assertIn("persist-credentials: false", self.text)

    def test_no_expression_is_interpolated_into_a_script(self) -> None:
        for workflow in sorted(WORKFLOWS.glob("*.yml")):
            for script in run_scripts(workflow.read_text(encoding="utf-8")):
                with self.subTest(workflow=workflow.name, script=script[:60]):
                    self.assertNotIn("${{", script)


def workspace_dependencies(units: list[str]) -> dict[str, set[str]]:
    projects = {
        unit: tomllib.loads((REPOSITORY / unit / "pyproject.toml").read_text(encoding="utf-8"))
        for unit in units
    }
    directory = {project["project"]["name"]: unit for unit, project in projects.items()}
    direct = {
        unit: {
            directory[name]
            for name, source in project.get("tool", {}).get("uv", {}).get("sources", {}).items()
            if source.get("workspace")
        }
        for unit, project in projects.items()
    }
    closure = {unit: set(dependencies) for unit, dependencies in direct.items()}
    for _ in units:
        for dependencies in closure.values():
            dependencies.update(*(closure[dependency] for dependency in list(dependencies)))
    return closure


def hook_files(hooks: str, hook_id: str) -> str | None:
    match = re.search(rf"- id: {re.escape(hook_id)}\n(?:.*\n)*?\s+files: (.+)", hooks)
    return match[1] if match else None


def lane_filter(ci: str) -> str:
    match = re.search(r"grep -qE '([^']+)'", ci[ci.index("- id: lane-changes") :])
    assert match is not None
    return match[1]


def a_change_in(directory: str) -> str:
    return f"{directory}/src/probe.py"


class PythonUnits(unittest.TestCase):
    def setUp(self) -> None:
        project = tomllib.loads((REPOSITORY / "pyproject.toml").read_text(encoding="utf-8"))
        self.units = project["tool"]["uv"]["workspace"]["members"]
        self.ci = read("ci.yml")
        self.hooks = (REPOSITORY / ".pre-commit-config.yaml").read_text(encoding="utf-8")
        self.dependencies = workspace_dependencies(self.units)

    def test_a_units_hook_runs_when_a_unit_it_uses_changes(self) -> None:
        for unit, dependencies in self.dependencies.items():
            name = tomllib.loads((REPOSITORY / unit / "pyproject.toml").read_text())["project"]
            files = hook_files(self.hooks, f"{name['name']}-gate")
            if files is None:
                continue
            for dependency in (unit, *dependencies):
                with self.subTest(unit=unit, dependency=dependency):
                    self.assertRegex(a_change_in(dependency), files)

    def test_the_lane_runs_when_a_unit_its_tests_use_changes(self) -> None:
        detection = lane_filter(self.ci)
        for unit in (*LANE_ONLY_UNITS, *SPLIT_BY_MARKER_UNITS):
            for dependency in (unit, *self.dependencies[unit]):
                with self.subTest(unit=unit, dependency=dependency):
                    self.assertRegex(a_change_in(dependency), detection)

    def test_the_lane_does_not_run_for_documentation(self) -> None:
        detection = lane_filter(self.ci)
        for path in ("docs/roadmap.md", "README.md", "tools/check_links.py"):
            with self.subTest(path=path):
                self.assertNotRegex(path, detection)

    def test_every_unit_is_type_checked_on_its_own(self) -> None:
        for unit in self.units:
            with self.subTest(unit=unit):
                self.assertIn(f"uv run --frozen mypy {unit}\n", self.ci)
                self.assertRegex(self.hooks, rf"uv run --frozen mypy {re.escape(unit)}['\n &]")

    def test_every_unit_outside_the_lane_runs_its_gate_tests(self) -> None:
        for unit in self.units:
            if unit in LANE_ONLY_UNITS:
                continue
            gate = f"uv run --frozen pytest {unit}/tests"
            if unit in SPLIT_BY_MARKER_UNITS:
                gate += f" {NOT_IN_THE_LANE}"
            with self.subTest(unit=unit):
                self.assertIn(f"{gate}\n", self.ci)
                self.assertIn(f"{gate}'", self.hooks)

    def test_every_unit_with_database_tests_runs_them_in_the_lane(self) -> None:
        marked = {
            unit
            for unit in self.units
            if any(
                "pytest.mark.lane" in path.read_text(encoding="utf-8")
                for path in (REPOSITORY / unit).rglob("test_*.py")
            )
        }
        self.assertEqual(marked, set(SPLIT_BY_MARKER_UNITS))
        lane = self.ci[self.ci.index(LANE_STEP) :]
        for unit in (*LANE_ONLY_UNITS, *SPLIT_BY_MARKER_UNITS):
            selection = "" if unit in LANE_ONLY_UNITS else " -m lane"
            with self.subTest(unit=unit):
                self.assertIn(f"uv run --frozen pytest {unit}/tests{selection}\n", lane)


class Rulesets(unittest.TestCase):
    def setUp(self) -> None:
        self.branch_rulesets = [
            json.loads((RULESETS / name).read_text(encoding="utf-8"))
            for name in ("main.json", "develop.json")
        ]

    def rule(self, ruleset: dict[str, Any], kind: str) -> dict[str, Any]:
        parameters: dict[str, Any] = next(
            rule for rule in ruleset["rules"] if rule["type"] == kind
        )["parameters"]
        return parameters

    def test_required_checks_are_job_names_that_exist(self) -> None:
        job_names = set(
            re.findall(r"^    name: (.+)$", read("ci.yml") + read("pr-policy.yml"), re.MULTILINE)
        )
        for ruleset in self.branch_rulesets:
            contexts = {
                check["context"]
                for check in self.rule(ruleset, "required_status_checks")["required_status_checks"]
            }
            with self.subTest(ruleset=ruleset["name"]):
                self.assertEqual(contexts, {"Gate", "Pull request policy"})
                self.assertLessEqual(contexts, job_names)

    def test_merge_commits_only(self) -> None:
        for ruleset in self.branch_rulesets:
            with self.subTest(ruleset=ruleset["name"]):
                self.assertEqual(
                    self.rule(ruleset, "pull_request")["allowed_merge_methods"], ["merge"]
                )

    def test_nobody_bypasses(self) -> None:
        for path in sorted(RULESETS.glob("*.json")):
            with self.subTest(ruleset=path.name):
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["bypass_actors"], [])


class Release(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("release.yml")

    def test_every_gh_pr_command_names_the_repository(self) -> None:
        commands = [
            match.start()
            for match in re.finditer(r"\bgh (pr|release) (create|list|merge|view)\b", self.text)
        ]
        self.assertTrue(commands)
        for start in commands:
            command = self.text[start:].split("\n\n", 1)[0]
            with self.subTest(command=command.splitlines()[0]):
                self.assertIn("--repo", command)

    def test_no_failure_is_turned_into_a_message(self) -> None:
        self.assertIsNone(re.search(r"\|\|\s*echo", self.text))

    def test_the_back_merge_never_comes_from_main(self) -> None:
        self.assertIn('source="backmerge/$VERSION"', self.text)
        self.assertNotIn("--head main", self.text)


if __name__ == "__main__":
    unittest.main()
