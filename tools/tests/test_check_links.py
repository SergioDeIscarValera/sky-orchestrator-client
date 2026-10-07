from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_links  # noqa: E402


class Extraction(unittest.TestCase):
    def test_a_plain_link(self) -> None:
        self.assertEqual(check_links.link_targets("see [docs](docs/README.md)"), ["docs/README.md"])

    def test_an_image(self) -> None:
        self.assertEqual(check_links.link_targets("![alt](img/x.png)"), ["img/x.png"])

    def test_a_link_with_a_title(self) -> None:
        self.assertEqual(check_links.link_targets('[x](a/b.md "a title")'), ["a/b.md"])

    def test_code_is_not_prose(self) -> None:
        text = "```\n[not a link](nope.md)\n```\n`[example](nope.md)` and [real](yes.md)"
        self.assertEqual(check_links.link_targets(text), ["yes.md"])


class Classification(unittest.TestCase):
    def test_external_and_anchor_targets_are_not_local(self) -> None:
        for target in ("https://example.com", "http://x.y", "mailto:a@b.c", "ftp://x.y", "#top"):
            with self.subTest(target=target):
                self.assertFalse(check_links.is_local(target))

    def test_a_relative_path_is_local(self) -> None:
        self.assertTrue(check_links.is_local("docs/README.md"))


class Resolution(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def write(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def broken_targets(self) -> list[str]:
        return [link.target for link in check_links.broken_links(self.root)]

    def test_a_resolving_link_passes(self) -> None:
        self.write("target.md", "# target")
        self.write("README.md", "see [target](target.md)")
        self.assertEqual(self.broken_targets(), [])

    def test_a_missing_target_is_reported(self) -> None:
        self.write("README.md", "see [gone](missing.md)")
        self.assertEqual(self.broken_targets(), ["missing.md"])

    def test_the_anchor_is_ignored_when_resolving(self) -> None:
        self.write("target.md", "# target")
        self.write("README.md", "see [target](target.md#a-heading)")
        self.assertEqual(self.broken_targets(), [])

    def test_links_up_a_directory_and_to_a_directory(self) -> None:
        self.write("top.md", "# top")
        self.write("docs/inner.md", "see [top](../top.md) and [here](./)")
        self.assertEqual(self.broken_targets(), [])

    def test_dependency_directories_are_skipped(self) -> None:
        self.write("node_modules/pkg/README.md", "see [gone](missing.md)")
        self.write(".venv/lib/README.md", "see [gone](missing.md)")
        self.assertEqual(self.broken_targets(), [])

    def test_exit_status_follows_the_result(self) -> None:
        self.write("README.md", "see [gone](missing.md)")
        self.assertEqual(check_links.main([str(self.root)]), 1)
        self.write("missing.md", "# here")
        self.assertEqual(check_links.main([str(self.root)]), 0)


if __name__ == "__main__":
    unittest.main()
