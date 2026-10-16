from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path, PurePosixPath
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import vendor_sky_orchestrator as vso

SOURCE_FILES = {
    "contracts/mqtt/dji-envelope.schema.json": '{"$defs": {}}\n',
    "contracts/mqtt/sys/update_topo.schema.json": '{"title": "update_topo"}\n',
    "contracts/mqtt/examples/sys.update_topo.json": '{"method": "update_topo"}\n',
    "contracts/mqtt/internal/bridge-link.schema.json": '{"title": "internal"}\n',
    "contracts/mqtt/README.md": "# Wire\n",
    "contracts/wayline/openapi.yaml": "openapi: 3.1.0\n",
    "contracts/wayline/README.md": "# Wayline\n",
    "contracts/config/so-config.schema.json": "{}\n",
    "infra/compose/compose.yaml": "services: {}\n",
    "infra/compose/compose.release.yaml": "services: {}\n",
    "infra/compose/.env.example": "SO_BIND=127.0.0.1\n",
    "infra/mosquitto/acl": "user cloud-client\n",
    "infra/mosquitto/entrypoint.sh": '#!/bin/sh\nexec "$@"\n',
    "infra/mosquitto/mosquitto.conf": "allow_anonymous false\n",
    "infra/tests/fixtures/replay/square-flight.jsonl": '{"kind": "mission_started"}\n',
}
EXECUTABLES = ("infra/mosquitto/entrypoint.sh",)
CONTRACTS = [
    "mqtt/dji-envelope.schema.json",
    "mqtt/examples/sys.update_topo.json",
    "mqtt/sys/update_topo.schema.json",
    "wayline/openapi.yaml",
]
STACK = {
    "config/so-config.schema.json": "contracts/config/so-config.schema.json",
    "stack/compose/compose.release.yaml": "infra/compose/compose.release.yaml",
    "stack/compose/compose.yaml": "infra/compose/compose.yaml",
    "stack/mosquitto/acl": "infra/mosquitto/acl",
    "stack/mosquitto/entrypoint.sh": "infra/mosquitto/entrypoint.sh",
    "stack/mosquitto/mosquitto.conf": "infra/mosquitto/mosquitto.conf",
    "stack/tests/fixtures/replay/square-flight.jsonl": (
        "infra/tests/fixtures/replay/square-flight.jsonl"
    ),
}
VENDORED = sorted([*CONTRACTS, *STACK])


def git(directory: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(directory), *arguments],
        capture_output=True,
        text=True,
        check=True,
        env=vso.outside_this_repository(),
    ).stdout.strip()


class Workspace:
    def __init__(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.source = root / "sky-orchestrator"
        self.destination = root / "contracts" / "sky-orchestrator"
        self.source.mkdir()
        git(self.source, "init", "-q")
        for path, text in SOURCE_FILES.items():
            target = self.source / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
            if path in EXECUTABLES:
                target.chmod(0o755)
        self.commit = self.commit_all("first")

    def commit_all(self, message: str) -> str:
        git(self.source, "add", "-A")
        git(
            self.source,
            "-c", "user.name=SO", "-c", "user.email=so@example.org",
            "commit", "-q", "--no-verify", "-m", message,
        )  # fmt: skip
        return git(self.source, "rev-parse", "HEAD")

    def vendor(self, commit: str | None = None) -> dict[str, str]:
        return vso.vendor(self.source, commit or self.commit, self.destination)

    def close(self) -> None:
        self.directory.cleanup()


class Selection(unittest.TestCase):
    def test_the_wire_schemas_examples_and_the_http_contract_are_wanted(self) -> None:
        for path in (
            "contracts/mqtt/dji-envelope.schema.json",
            "contracts/mqtt/osd/aircraft.schema.json",
            "contracts/mqtt/examples/osd.aircraft.json",
            "contracts/mqtt/dji-methods.json",
            "contracts/wayline/openapi.yaml",
            "contracts/msdk/geodesy-cases.json",
            "contracts/msdk/mission-plan.schema.json",
            "contracts/msdk/examples/mission-plan.square.json",
            "contracts/wpml/supported-subset.md",
        ):
            with self.subTest(path=path):
                self.assertTrue(vso.wanted(PurePosixPath(path)))

    def test_internal_buses_the_phone_bridge_and_prose_are_not(self) -> None:
        for path in (
            "contracts/mqtt/internal/bridge-link.schema.json",
            "contracts/mqtt/internal/examples/bridge-link.up.json",
            "contracts/mqtt/README.md",
            "contracts/wayline/README.md",
            "contracts/msdk/openapi.yaml",
            "contracts/msdk/examples/bridge/telemetry.json",
            "contracts/msdk/README.md",
        ):
            with self.subTest(path=path):
                self.assertFalse(vso.wanted(PurePosixPath(path)))


class Vendoring(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.addCleanup(self.workspace.close)

    def test_the_wanted_files_are_copied_byte_for_byte_with_their_hashes(self) -> None:
        files = self.workspace.vendor()
        self.assertEqual(sorted(files), VENDORED)
        for path in CONTRACTS:
            with self.subTest(path=path):
                original = (self.workspace.source / "contracts" / path).read_bytes()
                self.assertEqual((self.workspace.destination / path).read_bytes(), original)
                self.assertEqual(files[path], vso.sha256(original))

    def test_the_manifest_pins_the_full_commit(self) -> None:
        self.workspace.vendor(self.workspace.commit[:8])
        manifest = json.loads((self.workspace.destination / "vendored.json").read_text())
        self.assertEqual(manifest["commit"], self.workspace.commit)
        self.assertEqual(manifest["repository"], vso.REPOSITORY)
        self.assertNotIn("files", manifest)
        self.assertRegex(manifest["committed"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertTrue(self.workspace.commit.startswith(manifest["describe"]))

    def test_a_release_is_named_by_its_tag(self) -> None:
        git(self.workspace.source, "tag", "v0.4.1")
        self.workspace.vendor("v0.4.1")
        manifest = json.loads((self.workspace.destination / "vendored.json").read_text())
        self.assertEqual(manifest["describe"], "v0.4.1")
        self.assertEqual(manifest["commit"], self.workspace.commit)

    def test_the_files_come_from_the_commit_not_the_working_tree(self) -> None:
        (self.workspace.source / "contracts/wayline/openapi.yaml").write_text("uncommitted\n")
        self.workspace.vendor()
        vendored = (self.workspace.destination / "wayline/openapi.yaml").read_text()
        self.assertEqual(vendored, "openapi: 3.1.0\n")

    def test_a_file_removed_upstream_is_removed_here(self) -> None:
        self.workspace.vendor()
        (self.workspace.source / "contracts/mqtt/sys/update_topo.schema.json").unlink()
        self.workspace.vendor(self.workspace.commit_all("remove"))
        self.assertFalse((self.workspace.destination / "mqtt/sys/update_topo.schema.json").exists())
        self.assertEqual(vso.problems(self.workspace.destination), [])

    def test_the_released_stack_keeps_its_layout_and_its_executable_entrypoint(self) -> None:
        files = self.workspace.vendor()
        for here, upstream in STACK.items():
            with self.subTest(path=here):
                original = (self.workspace.source / upstream).read_bytes()
                self.assertEqual((self.workspace.destination / here).read_bytes(), original)
                self.assertEqual(files[here], vso.sha256(original))
        entrypoint = self.workspace.destination / "stack" / "mosquitto" / "entrypoint.sh"
        self.assertTrue(entrypoint.stat().st_mode & 0o111)
        # The compose file reaches the broker's files as ../mosquitto, as upstream, and the
        # recorded flights it mounts as ../tests/fixtures/replay, so Docker creates neither.
        self.assertEqual(
            (self.workspace.destination / "stack" / "compose").parent / "mosquitto",
            entrypoint.parent,
        )
        replay = self.workspace.destination / "stack" / "tests" / "fixtures" / "replay"
        self.assertEqual(
            (self.workspace.destination / "stack" / "compose").parent / "tests" / "fixtures",
            replay.parent,
        )
        self.assertTrue((replay / "square-flight.jsonl").is_file())

    def test_nothing_else_of_the_infrastructure_is_taken(self) -> None:
        self.workspace.vendor()
        self.assertFalse(
            (self.workspace.destination / "stack" / "compose" / ".env.example").exists()
        )


class Checking(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.addCleanup(self.workspace.close)
        self.workspace.vendor()
        self.destination = self.workspace.destination

    def test_a_fresh_copy_agrees(self) -> None:
        self.assertEqual(vso.problems(self.destination), [])

    def test_an_edited_file_is_named(self) -> None:
        (self.destination / "mqtt/dji-envelope.schema.json").write_text('{"$defs": {"x": 1}}\n')
        self.assertEqual(
            vso.problems(self.destination),
            ["mqtt/dji-envelope.schema.json differs from Sky Orchestrator's at the pinned commit"],
        )

    def test_a_missing_file_is_named(self) -> None:
        (self.destination / "wayline/openapi.yaml").unlink()
        self.assertEqual(vso.problems(self.destination), ["wayline/openapi.yaml is missing"])

    def test_a_file_added_by_hand_is_named(self) -> None:
        (self.destination / "mqtt/sys/extra.schema.json").write_text("{}\n")
        self.assertEqual(
            vso.problems(self.destination), ["mqtt/sys/extra.schema.json is not in the manifest"]
        )

    def test_an_entrypoint_that_lost_its_executable_bit_is_named(self) -> None:
        workspace = Workspace()
        self.addCleanup(workspace.close)
        workspace.vendor()
        (workspace.destination / "stack" / "mosquitto" / "entrypoint.sh").chmod(0o644)
        self.assertEqual(
            vso.problems(workspace.destination),
            ["stack/mosquitto/entrypoint.sh is not executable, and the stack runs it"],
        )

    def test_a_missing_manifest_is_named(self) -> None:
        for name in ("vendored.json", "vendored.sha256"):
            with self.subTest(name=name):
                workspace = Workspace()
                self.addCleanup(workspace.close)
                workspace.vendor()
                (workspace.destination / name).unlink()
                self.assertEqual(
                    vso.problems(workspace.destination), [f"sky-orchestrator/{name} is missing"]
                )

    def test_the_checksums_are_in_sha256sums_format(self) -> None:
        checked = subprocess.run(
            ["sha256sum", "--check", "--quiet", "vendored.sha256"],
            cwd=self.destination,
            capture_output=True,
            text=True,
        )
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)


class Repository(unittest.TestCase):
    def test_the_committed_copy_agrees_with_its_manifest(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(vso.main(["--check"]), 0, output.getvalue())


class InsideAGitHook(unittest.TestCase):
    """A hook in a worktree exports GIT_DIR and GIT_INDEX_FILE, absolute."""

    def test_git_on_another_repository_leaves_this_one_alone(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            this = Path(directory) / "this"
            this.mkdir()
            git(this, "init", "-q")
            config = (this / ".git" / "config").read_text(encoding="utf-8")
            hook = {"GIT_DIR": str(this / ".git"), "GIT_INDEX_FILE": str(this / ".git" / "index")}
            with mock.patch.dict("os.environ", hook):
                workspace = Workspace()
                files = vso.vendor(workspace.source, workspace.commit, workspace.destination)
                provenance = json.loads((workspace.destination / vso.PROVENANCE).read_text())
                workspace.directory.cleanup()
            self.assertTrue(files)
            self.assertEqual(provenance["commit"], workspace.commit)
            self.assertEqual((this / ".git" / "config").read_text(encoding="utf-8"), config)
            self.assertEqual(git(this, "rev-list", "--all"), "")


if __name__ == "__main__":
    unittest.main()
