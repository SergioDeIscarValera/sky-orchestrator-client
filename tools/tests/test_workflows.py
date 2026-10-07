from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
RULESETS = WORKFLOWS.parent / "rulesets"


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
    SAMPLE = "on:\n  pull_request:\n    branches: [main]\n# note\njobs:\n  a:\n    x: 1\n  b:\n    y: 2\n"

    def test_child_keys_of_a_block(self) -> None:
        self.assertEqual(child_keys(block(self.SAMPLE, "jobs"), 2), ["a", "b"])

    def test_a_block_ends_at_the_next_top_level_key(self) -> None:
        self.assertEqual(child_keys(block(self.SAMPLE, "on"), 2), ["pull_request"])

    def test_a_missing_key_is_empty(self) -> None:
        self.assertEqual(block(self.SAMPLE, "permissions"), [])

    def test_run_scripts_inline_and_as_blocks(self) -> None:
        text = "steps:\n  - run: echo one\n  - run: |\n      echo two\n      echo three\n  - name: x\n"
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
        self.assertEqual(child_keys(block(self.text, "on"), 2), ["pull_request", "workflow_dispatch"])

    def test_every_check_is_present(self) -> None:
        for check in ("tools/check_links.py", "-size +512k", "unittest discover -s tools/tests", "gitleaks detect"):
            with self.subTest(check=check):
                self.assertIn(check, self.text)

    def test_checks_report_independently(self) -> None:
        steps_with_a_guard = self.text.count("!cancelled()")
        named_steps = len(re.findall(r"^      - name: ", self.text, re.MULTILINE))
        self.assertEqual(steps_with_a_guard, named_steps)


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


class Rulesets(unittest.TestCase):
    def setUp(self) -> None:
        self.branch_rulesets = [
            json.loads((RULESETS / name).read_text(encoding="utf-8")) for name in ("main.json", "develop.json")
        ]

    def rule(self, ruleset: dict, kind: str) -> dict:
        return next(rule for rule in ruleset["rules"] if rule["type"] == kind)["parameters"]

    def test_required_checks_are_job_names_that_exist(self) -> None:
        job_names = set(re.findall(r"^    name: (.+)$", read("ci.yml") + read("pr-policy.yml"), re.MULTILINE))
        for ruleset in self.branch_rulesets:
            contexts = {check["context"] for check in self.rule(ruleset, "required_status_checks")["required_status_checks"]}
            with self.subTest(ruleset=ruleset["name"]):
                self.assertEqual(contexts, {"Gate", "Pull request policy"})
                self.assertLessEqual(contexts, job_names)

    def test_merge_commits_only(self) -> None:
        for ruleset in self.branch_rulesets:
            with self.subTest(ruleset=ruleset["name"]):
                self.assertEqual(self.rule(ruleset, "pull_request")["allowed_merge_methods"], ["merge"])

    def test_nobody_bypasses(self) -> None:
        for path in sorted(RULESETS.glob("*.json")):
            with self.subTest(ruleset=path.name):
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["bypass_actors"], [])


class Release(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("release.yml")

    def test_every_gh_pr_command_names_the_repository(self) -> None:
        commands = [match.start() for match in re.finditer(r"\bgh (pr|release) (create|list|merge|view)\b", self.text)]
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
