from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from soc_database.harness import Tenancy, acting_as

CATALOGUE = Path(__file__).resolve().parents[2] / "contracts" / "catalogue" / "aircraft-models.json"
FIGURES = (
    "max_horizontal_speed_ms",
    "max_ascent_speed_ms",
    "max_descent_speed_ms",
    "max_flight_time_s",
    "max_service_ceiling_m",
    "max_wind_resistance_ms",
    "weight_g",
)


def catalogue() -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = json.loads(CATALOGUE.read_text(encoding="utf-8"))["models"]
    return models


def published(figure: dict[str, Any] | None) -> Any:
    return None if figure is None else figure["value"]


async def test_every_model_of_the_catalogue_is_loaded_as_published(
    session: asyncpg.Connection,
) -> None:
    rows = {row["model"]: row for row in await session.fetch("select * from soc.aircraft_models")}
    assert sorted(rows) == [model["model"] for model in catalogue()]
    for model in catalogue():
        row = rows[model["model"]]
        for figure in FIGURES:
            loaded = row[figure]
            assert (None if loaded is None else float(loaded)) == published(model[figure]), figure
        assert json.loads(row["camera"]) == {
            name: published(model["camera"][name])
            for name in ("sensor", "photo_resolution", "video_resolution", "zoom")
        }
        assert json.loads(row["thermal"])["capability"] == model["thermal"]["capability"]["value"]


async def test_every_published_figure_keeps_its_source(session: asyncpg.Connection) -> None:
    for row in await session.fetch("select * from soc.aircraft_models"):
        sources = json.loads(row["sources"])
        for figure in FIGURES:
            if row[figure] is not None:
                assert sources[figure].startswith("https://"), (row["model"], figure)
        assert set(row["source_urls"]) == set(sources.values())


async def test_every_signed_in_user_reads_the_catalogue_and_nobody_writes_it(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    viewer = await tenancy.member("viewer")
    async with acting_as(session, viewer.user_id):
        assert await session.fetchval("select count(*) from soc.aircraft_models") == len(
            catalogue()
        )
    for statement in (
        "update soc.aircraft_models set display_name = 'x'",
        "delete from soc.aircraft_models",
        "select soc.load_aircraft_models('{\"models\": []}')",
    ):
        async with acting_as(session, viewer.user_id):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await session.execute(statement)
    async with acting_as(session, None):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await session.fetch("select * from soc.aircraft_models")


async def test_loading_again_updates_in_place_and_removes_nothing(
    session: asyncpg.Connection,
) -> None:
    first = catalogue()[0]
    renamed = {"models": [{**first, "display_name": "Renamed for the test"}]}
    transaction = session.transaction()
    await transaction.start()
    try:
        assert (
            await session.fetchval(
                "select soc.load_aircraft_models($1::jsonb)", json.dumps(renamed)
            )
            == 1
        )
        assert await session.fetchval("select count(*) from soc.aircraft_models") == len(
            catalogue()
        )
        assert (
            await session.fetchval(
                "select display_name from soc.aircraft_models where model = $1",
                first["model"],
            )
            == "Renamed for the test"
        )
    finally:
        await transaction.rollback()
