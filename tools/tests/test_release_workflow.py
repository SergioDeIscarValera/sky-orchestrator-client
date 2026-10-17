"""The release workflow's deploy on the mini-PC keeps the guarantees ADR-0026 rests on.

The self-hosted runner runs on the farm's machine, beside Virtual Origen, with access to
Docker. These tests hold the shape that keeps it safe: only the deploy job runs there, only
on a merged release or a dispatch, behind its switch, reading packages and nothing more,
never cut short, and signing out of the registry whatever happens.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
RELEASE = WORKFLOWS / "release.yml"
COMPOSE = ROOT / "infra" / "compose" / "compose.yaml"


def block(text: str, header: str) -> str:
    """The lines under a header (e.g. '  deploy:'), up to the next line indented as much."""
    lines = text.splitlines()
    start = lines.index(header)
    indent = len(header) - len(header.lstrip())
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    return "\n".join(body)


def steps(job: str) -> list[str]:
    """Each step of a job, as its own text."""
    body = block(job, "    steps:")
    return [part for part in re.split(r"\n(?=      - )", "\n" + body) if part.strip()]


def run_script(step: str) -> str:
    """The shell script of a step's `run: |` block, dedented."""
    return textwrap.dedent(step.split("run: |\n", 1)[1])


def named(all_steps: list[str], name: str) -> str:
    return next(step for step in all_steps if f"- name: {name}\n" in step + "\n")


class Triggers(unittest.TestCase):
    def setUp(self) -> None:
        self.on = block(RELEASE.read_text(encoding="utf-8"), "on:")

    def test_only_a_closed_pull_request_into_main_or_a_dispatch_starts_it(self) -> None:
        events = re.findall(r"(?m)^  ([a-z_]+):", self.on)
        self.assertEqual(events, ["pull_request", "workflow_dispatch"])
        self.assertIn("types: [closed]", self.on)
        self.assertIn("branches: [main]", self.on)

    def test_a_dispatch_names_the_tag_it_deploys(self) -> None:
        dispatch = block(self.on, "  workflow_dispatch:")
        self.assertIn("tag:", dispatch)
        self.assertIn("required: true", dispatch)


class Deploy(unittest.TestCase):
    def setUp(self) -> None:
        self.text = RELEASE.read_text(encoding="utf-8")
        self.job = block(self.text, "  deploy:")
        self.steps = steps(self.job)

    def test_it_runs_on_the_mini_pc_runner(self) -> None:
        self.assertIn("runs-on: [self-hosted, minipc]", self.job)

    def test_it_runs_only_with_the_switch_on(self) -> None:
        self.assertIn("vars.SOC_MINIPC_DEPLOY_ENABLED == 'true'", self.job)

    def test_a_release_deploys_only_once_its_images_are_published(self) -> None:
        self.assertIn("needs: [tag, images]", self.job)
        self.assertIn(
            "github.event_name == 'pull_request' && needs.images.result == 'success'", self.job
        )

    def test_it_reads_contents_and_packages_and_writes_nothing(self) -> None:
        permissions = block(self.job, "    permissions:")
        self.assertEqual(
            sorted(line.strip() for line in permissions.splitlines() if line.strip()),
            ["contents: read", "packages: read"],
        )

    def test_one_deploy_runs_at_a_time_and_none_is_cut_short(self) -> None:
        concurrency = block(self.job, "    concurrency:")
        self.assertIn("group: soc-minipc-deploy", concurrency)
        self.assertIn("cancel-in-progress: false", concurrency)
        self.assertRegex(self.job, r"(?m)^    timeout-minutes: \d+$")

    def test_the_version_is_refused_unless_it_is_a_release_tag(self) -> None:
        self.assertIn("Refuse a version that is not a release tag", self.steps[0])
        self.assertIn("^v[0-9]+\\.[0-9]+\\.[0-9]+$", self.steps[0])

    def test_it_checks_out_the_tag_it_deploys(self) -> None:
        self.assertIn("ref: refs/tags/${{ env.VERSION }}", self.job)

    def test_it_signs_in_with_the_jobs_own_token_and_always_signs_out_last(self) -> None:
        self.assertIn("printf '%s' \"$GH_TOKEN\" | docker login ghcr.io", self.job)
        self.assertIn("GH_TOKEN: ${{ github.token }}", self.job)
        last = self.steps[-1]
        self.assertIn("if: always()", last)
        self.assertIn("docker logout ghcr.io", last)

    def test_it_deploys_through_the_deploy_command_that_refuses_during_a_flight(self) -> None:
        deploy = named(self.steps, "Deploy")
        self.assertIn(
            'python3 "$STACK_DIR/deploy.py" "$VERSION" --compose-dir "$STACK_DIR"', deploy
        )
        self.assertNotIn("--ignore-flight", self.job)

    def test_it_never_prints_the_interpolated_configuration(self) -> None:
        self.assertNotIn("compose config", self.job)
        self.assertNotIn("docker inspect", self.job)

    def test_it_checks_every_file_the_compose_project_reads_from_the_stack(self) -> None:
        compose = COMPOSE.read_text(encoding="utf-8")
        wanted = set(re.findall(r"env_file: \[([a-z.-]+)\]", compose))
        wanted |= set(re.findall(r"- \./([a-z-]+\.json):", compose))
        listed = re.findall(r"for file in (.*?); do", named(self.steps, "Check the mini-PC"))
        checked = {name for names in listed for name in names.split()}
        self.assertEqual(checked, wanted | {".env"})


SECRETS = (".env", "migrate.env", "soc-cloud.env", "soc-operations.env", "soc-web.env")
CONFIGURATION = ("soc-cloud.json", "soc-operations.json", "soc-web.json")


class CheckTheMiniPc(unittest.TestCase):
    """The step that refuses a stack folder the deploy would fail on, or leak from, run as is."""

    def setUp(self) -> None:
        job = block(RELEASE.read_text(encoding="utf-8"), "  deploy:")
        self.script = run_script(named(steps(job), "Check the mini-PC"))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.stack = self.root / "stack"
        self.stack.mkdir()
        for name in SECRETS:
            (self.stack / name).write_text("X=1\n")
            (self.stack / name).chmod(0o600)
        for name in CONFIGURATION:
            (self.stack / name).write_text("{}\n")
            (self.stack / name).chmod(0o644)
        self.docker(0)

    def docker(self, status: int) -> None:
        bin_dir = self.root / "bin"
        bin_dir.mkdir(exist_ok=True)
        fake = bin_dir / "docker"
        fake.write_text(f"#!/bin/sh\nexit {status}\n")
        fake.chmod(0o755)

    def check(self) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "PATH": f"{self.root / 'bin'}{os.pathsep}{os.environ['PATH']}",
            "STACK_DIR": str(self.stack),
        }
        return subprocess.run(
            ["bash", "-c", self.script],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_a_complete_stack_folder_passes(self) -> None:
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_runner_that_cannot_reach_docker_is_named(self) -> None:
        self.docker(1)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("is it in group docker?", result.stderr)

    def test_a_missing_folder_is_refused(self) -> None:
        self.stack = self.root / "absent"
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("is missing or not writable", result.stderr)

    def test_every_missing_file_is_named_in_one_run(self) -> None:
        (self.stack / "migrate.env").unlink()
        (self.stack / "soc-web.json").unlink()
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("migrate.env is missing", result.stderr)
        self.assertIn("soc-web.json is missing", result.stderr)

    def test_a_secrets_file_others_can_read_is_refused(self) -> None:
        (self.stack / "soc-cloud.env").chmod(0o644)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("soc-cloud.env is mode 644, not 600", result.stderr)

    def test_a_configuration_file_the_services_cannot_read_is_refused(self) -> None:
        (self.stack / "soc-operations.json").chmod(0o600)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("soc-operations.json is not readable by others", result.stderr)

    def test_it_never_prints_what_a_file_holds(self) -> None:
        (self.stack / "soc-cloud.env").write_text("SOC_SO_API_TOKEN_FARM=never-printed\n")
        (self.stack / "soc-cloud.env").chmod(0o640)
        result = self.check()
        self.assertNotIn("never-printed", result.stdout + result.stderr)


class OnlyTheDeployRunsOnTheFarm(unittest.TestCase):
    def test_no_other_job_in_any_workflow_names_a_self_hosted_runner(self) -> None:
        found = [
            (path.name, line.strip())
            for path in sorted(WORKFLOWS.glob("*.yml"))
            for line in path.read_text(encoding="utf-8").splitlines()
            if "self-hosted" in line and not line.lstrip().startswith("#")
        ]
        self.assertEqual(found, [("release.yml", "runs-on: [self-hosted, minipc]")])


if __name__ == "__main__":
    unittest.main()
