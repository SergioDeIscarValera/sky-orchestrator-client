from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import catalogue_migration as cm

SOURCE = "https://www.dji.com/mavic-air-2/specs"
CATALOGUE = {
    "models": [
        {
            "model": "mavic-air-2",
            "max_flight_time_s": {"value": 2040, "source": SOURCE},
            "max_wind_resistance_ms": None,
            "camera": {"zoom": {"value": "Digital 8x", "source": SOURCE}},
        }
    ]
}


class Rendering(unittest.TestCase):
    def test_a_rendered_load_embeds_the_catalogue_as_it_is(self) -> None:
        text = json.dumps(CATALOGUE, indent=2) + "\n"
        sql = cm.render(text)
        self.assertIn("select soc.load_aircraft_models($catalogue$", sql)
        self.assertEqual(cm.embedded(sql), text.rstrip())

    def test_sql_without_a_load_embeds_nothing(self) -> None:
        self.assertIsNone(cm.embedded("create table soc.x (id int);"))


class Sources(unittest.TestCase):
    def test_every_published_value_is_found(self) -> None:
        paths = [path for path, _ in cm.values(CATALOGUE)]
        self.assertEqual(paths, ["/models/0/max_flight_time_s", "/models/0/camera/zoom"])

    def test_a_value_without_an_https_source_is_named(self) -> None:
        broken = json.loads(json.dumps(CATALOGUE))
        broken["models"][0]["max_flight_time_s"]["source"] = "http://example.com"
        del broken["models"][0]["camera"]["zoom"]["source"]
        self.assertEqual(
            cm.unsourced(broken), ["/models/0/max_flight_time_s", "/models/0/camera/zoom"]
        )

    def test_an_unpublished_value_needs_no_source(self) -> None:
        self.assertEqual(cm.unsourced(CATALOGUE), [])


class NewestLoad(unittest.TestCase):
    def test_the_newest_migration_that_loads_the_catalogue_is_the_one_that_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            migrations = Path(directory)
            (migrations / "0006-aircraft-models.sql").write_text(cm.render('{"models": []}'))
            (migrations / "0007-other.sql").write_text("select 1;\n")
            (migrations / "0009-catalogue-1-1.sql").write_text(cm.render('{"models": [1]}'))
            found = cm.newest_load(migrations)
            assert found is not None
            self.assertEqual(
                (found[0].name, json.loads(found[1])), ("0009-catalogue-1-1.sql", {"models": [1]})
            )

    def test_no_load_at_all_is_none(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(cm.newest_load(Path(directory)))


if __name__ == "__main__":
    unittest.main()
