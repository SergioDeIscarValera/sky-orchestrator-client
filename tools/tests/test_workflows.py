from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path
from typing import Any

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
RULESETS = WORKFLOWS.parent / "rulesets"
REPOSITORY = WORKFLOWS.parents[1]
# GitHub's image by version: ubuntu-latest moves to a new release on GitHub's date.
RUNNER = "ubuntu-24.04"
LANE_STEP = "- name: Container lane against Postgres, Realtime and Mosquitto"
LANE_ONLY_UNITS = ("database",)
SPLIT_BY_MARKER_UNITS = (
    "libs/soc-db",
    "libs/soc-realtime",
    "services/soc-cloud",
    "services/soc-operations",
    "infra/check",
)
NOT_IN_THE_LANE = '-m "not lane"'
WEB_SOURCE = "apps/soc-web"
# A contract named in a string (contracts/config/...) or in Path code ("contracts" / "config").
CONTRACT_READ = re.compile(r'contracts(?:/|"\s*/\s*")([a-z-]+)')
# More paths than a pipe holds: a reader that quits early leaves the writer data to send.
FILLER = ["docs/filler.md"] * 50_000
WEB_GATE_CALLS = [
    "corepack enable",
    "pnpm install --frozen-lockfile",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm format:check",
    "pnpm test",
    "pnpm build",
    "pnpm budget",
    "pnpm secrets",
]
# Stands in for git: prints the paths in FAKE_GIT_LISTING for the one diff a detector runs.
# Printing a long file into a closed reader fails with SIGPIPE, as git's output does.
FAKE_GIT = """\
if [ -n "${FAKE_GIT_FAILS:-}" ] || [ "$*" != "diff --name-only origin/develop...HEAD" ]; then
  exit 128
fi
cat "$FAKE_GIT_LISTING"
"""
# Stands in for corepack and pnpm: records each call, and fails the ones in STUB_FAIL.
CALL_RECORDER = """\
command="$(basename "$0") $*"
printf '%s\\n' "$command" >> "$STUB_LOG"
case ",$STUB_FAIL," in
  *",$command,"*) exit 1 ;;
esac
"""


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

    def test_every_job_runs_on_a_pinned_runner_image(self) -> None:
        for workflow in sorted(WORKFLOWS.glob("*.yml")):
            text = workflow.read_text(encoding="utf-8")
            runners = re.findall(r"runs-on: (\S+)", text)
            with self.subTest(workflow=workflow.name):
                self.assertEqual(len(runners), len(child_keys(block(text, "jobs"), 2)))
                self.assertEqual(set(runners), {RUNNER})

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
            "tools/catalogue_migration.py --check",
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

    def test_the_web_gate_runs_every_script_the_web_declares(self) -> None:
        scripts = json.loads((REPOSITORY / "apps" / "soc-web" / "package.json").read_text())[
            "scripts"
        ]
        gate = self.text[self.text.index("- name: soc-web gate") :].split("\n\n")[0] + "\n"
        for script in ("typecheck", "lint", "format:check", "test", "build", "budget", "secrets"):
            with self.subTest(script=script):
                self.assertIn(script, scripts)
                self.assertIn(f"pnpm {script}\n", gate)
        self.assertIn("pnpm install --frozen-lockfile", gate)

    def test_the_web_gate_runs_when_a_contract_the_web_reads_changes(self) -> None:
        sources = (REPOSITORY / "apps" / "soc-web" / "src").rglob("*.ts*")
        read = sorted(
            {
                directory
                for source in sources
                for directory in re.findall(r"contracts/([a-z-]+)/", source.read_text())
            }
        )
        self.assertTrue(read)
        detection = re.search(
            r"grep -qE '([^']+)'", self.text[self.text.index("- id: web-changes") :]
        )
        assert detection is not None
        hooks = (REPOSITORY / ".pre-commit-config.yaml").read_text(encoding="utf-8")
        hook = hook_files(hooks, "soc-web-gate")
        assert hook is not None
        for directory in read:
            with self.subTest(contract=directory):
                self.assertRegex(f"contracts/{directory}/probe.json", detection[1])
                self.assertRegex(f"contracts/{directory}/probe.json", hook)

    def test_every_step_after_the_setup_reports_independently(self) -> None:
        steps = re.split(r"^      - ", self.text, flags=re.MULTILINE)[1:]
        unguarded = [step.splitlines()[0] for step in steps if "!cancelled()" not in step]
        self.assertEqual(unguarded, ["id: checkout", "id: python"])

    def test_the_database_lane_runs_only_when_what_it_tests_changes(self) -> None:
        step = self.text[self.text.index(LANE_STEP) :]
        self.assertIn("steps.lane-changes.outputs.changed == 'true'", step.splitlines()[1])

    def test_no_step_feeds_a_quiet_grep_from_a_pipe(self) -> None:
        # grep -q quits at its first match; the writer then fails under pipefail, and the if
        # reads that failure as no match.
        self.assertNotRegex(self.text, r"(?<!\|)\|(?!\|)\s*grep -q")

    def test_each_change_detector_finds_a_match_that_is_first_in_a_long_list(self) -> None:
        for marker, path in (
            ("- id: lane-changes", "database/tests/test_probe.py"),
            ("- id: web-changes", "apps/soc-web/src/probe.ts"),
        ):
            with self.subTest(detector=marker):
                result, outputs = run_detector(self.text, marker, [path, *FILLER])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outputs, {"changed": "true"})

    def test_a_manual_run_runs_the_container_lane_without_asking_git(self) -> None:
        result, outputs = run_detector(
            self.text, "- id: lane-changes", [], base_ref="", git_fails=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {"changed": "true"})

    def test_a_failing_git_diff_fails_its_detector_rather_than_skipping_the_lane(self) -> None:
        for marker in ("- id: lane-changes", "- id: web-changes"):
            with self.subTest(detector=marker):
                result, outputs = run_detector(
                    self.text, marker, ["docs/roadmap.md"], git_fails=True
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})

    def test_the_web_gate_runs_every_check_and_names_the_ones_that_failed(self) -> None:
        result, calls = run_web_gate(failing=("pnpm lint", "pnpm build"))
        self.assertEqual(calls, WEB_GATE_CALLS)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("  pnpm lint", result.stderr.splitlines())
        self.assertIn("  pnpm build", result.stderr.splitlines())
        self.assertNotIn("  pnpm test", result.stderr.splitlines())

    def test_the_web_gate_passes_when_every_check_passes(self) -> None:
        result, calls = run_web_gate(failing=())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, WEB_GATE_CALLS)

    def test_the_web_gate_stops_when_the_install_fails(self) -> None:
        result, calls = run_web_gate(failing=("pnpm install --frozen-lockfile",))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, WEB_GATE_CALLS[:2])

    def test_the_uv_cache_is_off_and_the_step_says_why(self) -> None:
        step = self.text[self.text.index("      - id: uv\n") :].split("\n      - ", 1)[0]
        self.assertRegex(step, r"# .+\n\s+enable-cache: false")


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


def change_filter(ci: str, step_id: str) -> str:
    match = re.search(r"grep -qE '([^']+)'", ci[ci.index(f"- id: {step_id}") :])
    assert match is not None
    return match[1]


def lane_filter(ci: str) -> str:
    return change_filter(ci, "lane-changes")


def a_change_in(directory: str) -> str:
    return f"{directory}/src/probe.py"


def step_script(text: str, marker: str) -> str:
    """The run script of the step that starts at marker, dedented as the runner reads it."""
    lines = text[text.index(marker) :].splitlines()
    run = next(index for index, line in enumerate(lines) if line.strip() == "run: |")
    body: list[str] = []
    for line in lines[run + 1 :]:
        if line.strip() and indentation(line) <= indentation(lines[run]):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def fake_program(directory: Path, name: str, body: str) -> None:
    directory.mkdir(exist_ok=True)
    program = directory / name
    program.write_text(f"#!/usr/bin/env bash\n{body}", encoding="utf-8")
    program.chmod(0o755)


def run_script(
    script: str, directory: Path, environment: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    """Runs a step's script the way the runner does: bash -e, in directory."""
    path = directory / "step.sh"
    path.write_text(script, encoding="utf-8")
    return subprocess.run(
        ["bash", "-e", str(path)],
        cwd=directory,
        env={**os.environ, **environment},
        capture_output=True,
        text=True,
        check=False,
    )


def run_detector(
    text: str,
    marker: str,
    paths: list[str],
    *,
    base_ref: str = "develop",
    git_fails: bool = False,
) -> tuple[subprocess.CompletedProcess[str], dict[str, str]]:
    """Runs a change detector against a git that lists paths; returns the outputs it wrote."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        fake_program(root / "bin", "git", FAKE_GIT)
        listing = root / "listing.txt"
        listing.write_text("".join(f"{path}\n" for path in paths), encoding="utf-8")
        output = root / "github-output"
        environment = {
            "PATH": f"{root / 'bin'}{os.pathsep}{os.environ['PATH']}",
            "BASE_REF": base_ref,
            "FAKE_GIT_LISTING": str(listing),
            "GITHUB_OUTPUT": str(output),
        }
        if git_fails:
            environment["FAKE_GIT_FAILS"] = "1"
        result = run_script(step_script(text, marker), root, environment)
        outputs: dict[str, str] = {}
        if output.exists():
            for line in output.read_text(encoding="utf-8").splitlines():
                key, _, value = line.partition("=")
                outputs[key] = value
    return result, outputs


def run_web_gate(failing: tuple[str, ...]) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Runs the soc-web gate with stand-in corepack and pnpm; returns the calls it made."""
    script = step_script(read("ci.yml"), "- name: soc-web gate")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        fake_program(root / "bin", "corepack", CALL_RECORDER)
        fake_program(root / "bin", "pnpm", CALL_RECORDER)
        log = root / "calls.log"
        environment = {
            "PATH": f"{root / 'bin'}{os.pathsep}{os.environ['PATH']}",
            "STUB_LOG": str(log),
            "STUB_FAIL": ",".join(failing),
        }
        result = run_script(script, root, environment)
        calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return result, calls


def dockerfiles() -> list[Path]:
    """Every Dockerfile of the working tree, outside hidden directories and node_modules."""
    found: list[Path] = []
    for directory, subdirectories, files in os.walk(REPOSITORY):
        subdirectories[:] = [
            name for name in subdirectories if not name.startswith(".") and name != "node_modules"
        ]
        found.extend(Path(directory, name) for name in files if name == "Dockerfile")
    return sorted(found)


def copied_sources(dockerfile: str) -> list[str]:
    """The build-context paths its COPY instructions read. Other stages and images are not."""
    sources: list[str] = []
    for instruction in dockerfile.replace("\\\n", " ").splitlines():
        words = instruction.split()
        if not words or words[0].upper() != "COPY" or any(w.startswith("--from") for w in words):
            continue
        operands = [word for word in words[1:] if not word.startswith("--")]
        sources.extend(operands[:-1])
    return sources


def contracts_read_by(paths: list[Path]) -> set[str]:
    texts = [path.read_text(encoding="utf-8") for path in paths]
    return {name for text in texts for name in CONTRACT_READ.findall(text)}


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

    def test_the_lane_runs_when_the_web_image_changes_not_its_source(self) -> None:
        detection = lane_filter(self.ci)
        for path in (
            "apps/soc-web/Dockerfile",
            "apps/soc-web/nginx/soc-web.sh",
            "apps/soc-web/pnpm-lock.yaml",
            "apps/soc-web/pnpm-workspace.yaml",
            ".dockerignore",
        ):
            with self.subTest(path=path):
                self.assertRegex(path, detection)
        self.assertNotRegex("apps/soc-web/src/app/Shell.tsx", detection)

    def test_the_lane_does_not_run_for_documentation(self) -> None:
        detection = lane_filter(self.ci)
        for path in ("docs/roadmap.md", "README.md", "tools/check_links.py"):
            with self.subTest(path=path):
                self.assertNotRegex(path, detection)

    def lane_inputs(self) -> list[Path]:
        """What the lane imports and builds: its units, their dependencies and the Dockerfiles."""
        units = {*LANE_ONLY_UNITS, *SPLIT_BY_MARKER_UNITS}
        for unit in list(units):
            units.update(self.dependencies[unit])
        python = [path for unit in sorted(units) for path in (REPOSITORY / unit).rglob("*.py")]
        return [*python, *dockerfiles()]

    def test_the_lane_runs_for_each_contract_a_lane_input_reads(self) -> None:
        detection = lane_filter(self.ci)
        for name in sorted(contracts_read_by(self.lane_inputs())):
            with self.subTest(contract=name):
                self.assertRegex(f"contracts/{name}/probe.json", detection)

    def test_the_lane_does_not_run_for_a_contract_no_lane_input_reads(self) -> None:
        detection = lane_filter(self.ci)
        readers = contracts_read_by(self.lane_inputs())
        for directory in sorted((REPOSITORY / "contracts").iterdir()):
            if directory.is_dir() and directory.name not in readers:
                with self.subTest(contract=directory.name):
                    self.assertNotRegex(f"contracts/{directory.name}/probe.json", detection)

    def test_the_lane_does_not_run_for_the_site_baking_tool(self) -> None:
        # soc-site runs by hand on the mini-PC: no image copies it and no lane test reads it.
        self.assertNotRegex("infra/site/src/soc_site/bake.py", lane_filter(self.ci))
        for unit in ("infra/check", "infra/compose", "infra/migrate"):
            with self.subTest(unit=unit):
                self.assertRegex(f"{unit}/probe.py", lane_filter(self.ci))

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


class DockerfileCopies(unittest.TestCase):
    def setUp(self) -> None:
        self.ci = read("ci.yml")

    def test_every_path_a_lane_image_copies_is_in_the_lane_filter(self) -> None:
        lane, web = lane_filter(self.ci), change_filter(self.ci, "web-changes")
        copies = [
            (dockerfile, source)
            for dockerfile in dockerfiles()
            for source in copied_sources(dockerfile.read_text(encoding="utf-8"))
        ]
        self.assertTrue(copies)
        for dockerfile, source in copies:
            path = REPOSITORY / source
            probe = a_change_in(source) if path.is_dir() else source
            # The web's whole source is the web gate's: the image builds it with the build,
            # budget and secrets that the web gate runs on every change under apps/soc-web/.
            detection = web if source == WEB_SOURCE else lane
            with self.subTest(dockerfile=str(dockerfile.relative_to(REPOSITORY)), source=source):
                self.assertTrue(path.exists())
                self.assertRegex(probe, detection)

    def test_the_lane_runs_for_the_geometry_library_the_images_copy(self) -> None:
        # COPY libs libs puts soc_geo into the service images, so the lane tests changes to it.
        self.assertRegex("libs/soc-geo/src/soc_geo/projection.py", lane_filter(self.ci))


class Dependencies(unittest.TestCase):
    def test_every_python_unit_builds_with_the_same_uv_build(self) -> None:
        project = tomllib.loads((REPOSITORY / "pyproject.toml").read_text(encoding="utf-8"))
        requirements = {
            unit: tomllib.loads((REPOSITORY / unit / "pyproject.toml").read_text())["build-system"][
                "requires"
            ]
            for unit in project["tool"]["uv"]["workspace"]["members"]
        }
        self.assertEqual(len({tuple(value) for value in requirements.values()}), 1, requirements)

    def test_node_types_follow_the_runtime_major(self) -> None:
        web = json.loads((REPOSITORY / "apps" / "soc-web" / "package.json").read_text())
        dependabot = (REPOSITORY / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        npm = dependabot[dependabot.index("package-ecosystem: npm") :]
        self.assertTrue(web["devDependencies"]["@types/node"].startswith("24."))
        self.assertTrue(web["engines"]["node"].startswith(">=24."))
        self.assertRegex(
            npm,
            r'- dependency-name: "@types/node"\n\s+update-types: \["version-update:semver-major"\]',
        )


class BaseImages(unittest.TestCase):
    def setUp(self) -> None:
        text = (REPOSITORY / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        start = text.index("package-ecosystem: docker")
        self.docker = text[start : text.index("package-ecosystem: npm")]

    def test_node_stays_on_the_lts_line_of_adr_0016(self) -> None:
        dockerfile = (REPOSITORY / "apps" / "soc-web" / "Dockerfile").read_text()
        self.assertIn("FROM node:24.", dockerfile)
        self.assertRegex(
            self.docker,
            r'- dependency-name: "node"\n\s+update-types: \["version-update:semver-major"\]',
        )

    def test_python_stays_on_the_line_of_adr_0017(self) -> None:
        for unit in ("services/soc-cloud", "services/soc-operations", "infra/migrate"):
            with self.subTest(unit=unit):
                self.assertIn("FROM python:3.14.", (REPOSITORY / unit / "Dockerfile").read_text())
        self.assertRegex(
            self.docker,
            r'- dependency-name: "python"\n\s+update-types: '
            r'\["version-update:semver-major", "version-update:semver-minor"\]',
        )

    def test_nginx_stays_on_its_stable_line(self) -> None:
        dockerfile = (REPOSITORY / "apps" / "soc-web" / "Dockerfile").read_text()
        minor = re.search(r"nginx-unprivileged:1\.(\d+)\.", dockerfile)
        assert minor is not None
        self.assertEqual(int(minor[1]) % 2, 0, "an odd nginx minor is the mainline")
        self.assertRegex(
            self.docker,
            r'- dependency-name: "nginxinc/nginx-unprivileged"\n\s+update-types: '
            r'\["version-update:semver-major", "version-update:semver-minor"\]',
        )


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

    def test_every_service_image_is_published_from_its_own_dockerfile(self) -> None:
        declared = re.search(r'SERVICES: "([^"]+)"', self.text)
        assert declared is not None
        published = dict(entry.split("=") for entry in declared[1].split())
        compose = (REPOSITORY / "infra" / "compose" / "compose.yaml").read_text(encoding="utf-8")
        self.assertEqual(set(published), set(re.findall(r"/([a-z-]+):\$\{SOC_VERSION", compose)))
        for service, dockerfile in published.items():
            with self.subTest(service=service):
                self.assertTrue((REPOSITORY / dockerfile).is_file())

    def test_only_the_images_job_may_write_packages(self) -> None:
        self.assertEqual(self.text.count("packages: write"), 1)
        images = self.text[self.text.index("  images:") : self.text.index("  back_merge:")]
        self.assertIn("packages: write", images)
        self.assertIn("needs: tag", images)

    def test_an_image_tag_is_never_moved(self) -> None:
        self.assertIn("Image tags are never moved", self.text)


if __name__ == "__main__":
    unittest.main()
