from __future__ import annotations

import re
import unittest
from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[2] / "infra" / "compose" / "compose.yaml"
STACK_MEMORY_MB = 512
UNITS_MB = {"M": 1, "G": 1024}
# Published on the mini-PC by Virtual Origen (Postgres, Kong, its web) and Sky
# Orchestrator (Mosquitto, so-wayline).
TAKEN_PORTS = {5432, 8000, 8443, 8080, 8081, 1883}
# A one-shot that runs another unit's image: soc-config ships in soc-cloud's.
IMAGE_OF = {"soc-web-check": "soc-cloud"}


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

    def test_the_project_runs_every_unit(self) -> None:
        self.assertEqual(
            set(self.services),
            {"soc-migrate", "soc-cloud", "soc-operations", "soc-web-check", "soc-web"},
        )

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

    def test_only_the_console_publishes_a_port_and_only_its_own(self) -> None:
        self.assertEqual(
            re.findall(r"\n\s+ports: (.+)", self.text),
            ['["${SOC_WEB_PORT:?set SOC_WEB_PORT}:8080"]'],
        )
        self.assertIn("ports:", self.services["soc-web"])

    def test_the_consoles_port_is_one_virtual_origen_and_sky_orchestrator_leave_free(
        self,
    ) -> None:
        example = (COMPOSE.parent / ".env.example").read_text(encoding="utf-8")
        match = re.search(r"^SOC_WEB_PORT=(\d+)$", example, re.MULTILINE)
        assert match is not None
        self.assertNotIn(int(match[1]), TAKEN_PORTS)

    def test_the_console_writes_only_to_a_small_tmpfs(self) -> None:
        self.assertIn('tmpfs: ["/tmp:size=4m"]', self.services["soc-web"])
        self.assertNotIn("networks:", self.services["soc-web"])

    def test_the_site_models_are_mounted_read_only_on_the_console_alone(self) -> None:
        volumes = re.findall(r"^      - (.+)$", self.services["soc-web"], re.MULTILINE)
        mounts = [volume for volume in volumes if "/srv/site" in volume]
        self.assertEqual(mounts, ["./site:/srv/site:ro"])
        for name, block in self.services.items():
            if name != "soc-web":
                with self.subTest(service=name):
                    self.assertNotIn("/srv/site", block)

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
                image = IMAGE_OF.get(name, name)
                self.assertRegex(block, rf"/{image}:\$\{{SOC_VERSION:\?")

    def test_the_console_starts_only_on_a_file_soc_config_accepted(self) -> None:
        check, web = self.services["soc-web-check"], self.services["soc-web"]
        mount = "./soc-web.json:/etc/soc/soc-web.json:ro"
        entrypoint = 'entrypoint: ["soc-config", "check", "soc-web", "/etc/soc/soc-web.json"]'
        self.assertIn(entrypoint, check)
        self.assertIn('restart: "no"', check)
        self.assertIn("network_mode: none", check)
        self.assertIn("soc-web-check: {condition: service_completed_successfully}", web)
        self.assertIn("SOC_CONFIG_FILE: /etc/soc/soc-web.json", web)
        for block in (check, web):
            with self.subTest(block=block[:20]):
                self.assertIn(mount, block)


if __name__ == "__main__":
    unittest.main()
