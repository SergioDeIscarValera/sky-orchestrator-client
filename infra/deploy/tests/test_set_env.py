from __future__ import annotations

import io
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import set_env

SCRIPT = Path(__file__).resolve().parents[1] / "set_env.py"
# Plain words, so no secret scanner mistakes a fixture for a key.
SECRET = "value-that-is-never-printed"
EXAMPLE = (
    b"# soc-cloud's environment.\n"
    b"SOC_DB_PASSWORD_SOC_CLOUD=replace-with-the-same-secret-as-migrate.env\n"
    b"SOC_SUPABASE_URL=http://kong:8000\r\n"
    b"SOC_SUPABASE_SERVICE_ROLE_KEY=replace-with-virtual-origen-service-role-key"
)


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.env = Path(folder.name) / "soc-cloud.env"
        self.env.write_bytes(EXAMPLE)
        self.env.chmod(0o600)

    def run_main(self, key: str, stdin: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO(stdin)),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            status = set_env.main([str(self.env), key])
        return status, out.getvalue(), err.getvalue()


class SetsTheLine(Fixture):
    def test_only_the_named_line_changes_and_keeps_its_line_ending(self) -> None:
        status, _, _ = self.run_main("SOC_SUPABASE_URL", "http://kong:8001\n")
        self.assertEqual(status, 0)
        self.assertEqual(
            self.env.read_bytes(), EXAMPLE.replace(b"http://kong:8000", b"http://kong:8001")
        )

    def test_the_last_line_without_an_ending_stays_without_one(self) -> None:
        self.run_main("SOC_SUPABASE_SERVICE_ROLE_KEY", "header.payload.signature\n")
        self.assertTrue(
            self.env.read_bytes().endswith(
                b"SOC_SUPABASE_SERVICE_ROLE_KEY=header.payload.signature"
            )
        )

    def test_the_file_keeps_its_mode(self) -> None:
        self.run_main("SOC_DB_PASSWORD_SOC_CLOUD", SECRET)
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o600)

    def test_a_percent_encoded_dsn_is_kept_as_written(self) -> None:
        dsn = "postgresql://postgres:p%40ss%2Fw0rd@db:5432/postgres"
        self.run_main("SOC_DB_PASSWORD_SOC_CLOUD", dsn + "\n")
        self.assertIn(f"SOC_DB_PASSWORD_SOC_CLOUD={dsn}\n".encode(), self.env.read_bytes())

    def test_only_the_first_line_of_stdin_is_the_value(self) -> None:
        self.run_main("SOC_DB_PASSWORD_SOC_CLOUD", f"{SECRET}\nsecond line\n")
        self.assertIn(f"SOC_DB_PASSWORD_SOC_CLOUD={SECRET}\n".encode(), self.env.read_bytes())
        self.assertNotIn(b"second line", self.env.read_bytes())

    def test_an_exported_line_is_set_too(self) -> None:
        self.env.write_bytes(b"export SOC_VERSION=v0.5.1\n")
        status, _, _ = self.run_main("SOC_VERSION", "v0.5.2")
        self.assertEqual(status, 0)
        self.assertEqual(self.env.read_bytes(), b"SOC_VERSION=v0.5.2\n")


class RefusesAndChangesNothing(Fixture):
    def assert_refused(self, key: str, stdin: str, reason: str) -> None:
        status, out, err = self.run_main(key, stdin)
        self.assertEqual(status, 1)
        self.assertEqual(self.env.read_bytes(), EXAMPLE)
        self.assertIn(reason, err)
        self.assertEqual(out, "")

    def test_a_key_the_file_lacks(self) -> None:
        self.assert_refused(
            "SOC_MQTT_PASSWORD_FARM", SECRET, "has no SOC_MQTT_PASSWORD_FARM= lines"
        )

    def test_a_key_the_file_holds_twice(self) -> None:
        self.env.write_bytes(EXAMPLE + b"\nSOC_SUPABASE_URL=http://other\n")
        status, _, err = self.run_main("SOC_SUPABASE_URL", "http://kong:8001")
        self.assertEqual(status, 1)
        self.assertIn("has 2 SOC_SUPABASE_URL= lines", err)

    def test_a_key_that_only_starts_like_another(self) -> None:
        self.assert_refused("SOC_SUPABASE", "x", "has no SOC_SUPABASE= lines")

    def test_a_key_that_is_not_a_variable_name(self) -> None:
        self.assert_refused("soc url", "x", "is not a variable name")

    def test_an_empty_value(self) -> None:
        self.assert_refused("SOC_SUPABASE_URL", "\n", "stdin held no value")
        self.assert_refused("SOC_SUPABASE_URL", "", "stdin held no value")

    def test_a_value_the_env_file_would_not_read_back(self) -> None:
        for value in ("a b", "a#b", "a$b", "a'b", 'a"b', "a`b", "a\\b", "a\tb"):
            with self.subTest(value=value):
                self.assert_refused("SOC_SUPABASE_URL", value, "would not read back as written")

    def test_a_missing_file(self) -> None:
        self.env.unlink()
        status, _, err = self.run_main("SOC_SUPABASE_URL", "x")
        self.assertEqual(status, 1)
        self.assertIn("Cannot read", err)


class NeverPrintsTheValue(Fixture):
    def test_not_when_it_sets_it(self) -> None:
        _, out, err = self.run_main("SOC_DB_PASSWORD_SOC_CLOUD", SECRET)
        self.assertEqual(out.strip(), f"{self.env}: SOC_DB_PASSWORD_SOC_CLOUD set")
        self.assertNotIn(SECRET, out + err)

    def test_not_when_it_refuses_it(self) -> None:
        _, out, err = self.run_main("SOC_MQTT_PASSWORD_FARM", SECRET)
        self.assertNotIn(SECRET, out + err)
        _, out, err = self.run_main("SOC_SUPABASE_URL", SECRET + " tail")
        self.assertNotIn(SECRET, out + err)


class AsACommand(Fixture):
    def test_it_runs_from_any_folder_reading_stdin(self) -> None:
        result = subprocess.run(  # noqa: S603 - this unit's own script, a fixed argument list
            [sys.executable, str(SCRIPT), str(self.env), "SOC_DB_PASSWORD_SOC_CLOUD"],
            input=SECRET + "\n",
            capture_output=True,
            text=True,
            cwd=self.env.parent,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"SOC_DB_PASSWORD_SOC_CLOUD={SECRET}\n".encode(), self.env.read_bytes())
        self.assertNotIn(SECRET, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
