from __future__ import annotations

import re
import unittest
from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[2] / "infra" / "compose" / "compose.yaml"
STACK_MEMORY_MB = 512
UNITS_MB = {"M": 1, "G": 1024}


def services(text: str) -> dict[str, str]:
    body = text[text.index("\nservices:\n") + len("\nservices:\n") : text.index("\nnetworks:\n")]
    found: dict[str, str] = {}
    for block in re.split(r"\n(?=  [a-z][a-z0-9-]*:\n)", "\n" + body.strip("\n")):
        match = re.match(r"\n?  ([a-z][a-z0-9-]*):\n", block)
        if match:
            found[match[1]] = block
    return found


class ComposeProject(unittest.TestCase):
    def setUp(self) -> None:
        self.text = COMPOSE.read_text(encoding="utf-8")
        self.services = services(self.text)

    def test_the_project_runs_every_backend_unit(self) -> None:
        self.assertEqual(set(self.services), {"soc-migrate", "soc-cloud", "soc-operations"})

    def test_every_container_declares_its_memory_and_cpu_limits(self) -> None:
        for name, block in self.services.items():
            with self.subTest(service=name):
                self.assertRegex(block, r"limits: \{memory: \d+[MG], cpus: \"[0-9.]+\"\}")

    def test_the_memory_limits_add_up_to_512_mb_at_most(self) -> None:
        total = sum(
            int(amount) * UNITS_MB[unit]
            for amount, unit in re.findall(r"memory: (\d+)([MG])", self.text)
        )
        self.assertLessEqual(total, STACK_MEMORY_MB)

    def test_every_container_is_read_only_unprivileged_and_without_capabilities(self) -> None:
        self.assertIn("read_only: true", self.text)
        self.assertIn('security_opt: ["no-new-privileges:true"]', self.text)
        self.assertIn("cap_drop: [ALL]", self.text)
        for name, block in self.services.items():
            with self.subTest(service=name):
                self.assertIn("<<: *hardened", block)

    def test_no_port_is_published(self) -> None:
        self.assertNotRegex(self.text, r"\n\s+ports:")

    def test_the_networks_are_virtual_origens_and_sky_orchestrators_own(self) -> None:
        networks = self.text[self.text.index("\nnetworks:\n") :]
        self.assertEqual(networks.count("external: true"), 2)
        self.assertIn("supabase-local_default", networks)
        self.assertIn("sky-orchestrator_default", networks)

    def test_flight_files_are_offered_on_sky_orchestrators_network_only(self) -> None:
        cloud = self.services["soc-cloud"]
        self.assertIn("sky-orchestrator:\n        aliases: [soc-cloud]", cloud)
        for name in ("soc-operations", "soc-migrate"):
            with self.subTest(service=name):
                self.assertIn("    networks: [virtual-origen]\n", self.services[name] + "\n")

    def test_images_are_pinned_to_a_version(self) -> None:
        for name, block in self.services.items():
            with self.subTest(service=name):
                self.assertRegex(block, rf"/{name}:\$\{{SOC_VERSION:\?")


if __name__ == "__main__":
    unittest.main()
