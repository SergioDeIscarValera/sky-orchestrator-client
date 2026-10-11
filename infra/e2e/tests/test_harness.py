"""The end to end's own pieces, without Docker: what the dock sends follows Sky
Orchestrator's contract, the flight is the one described, and Kong routes as
Supabase's kong.yml does."""

from __future__ import annotations

import math

from soc_cloud.wire import WireContract
from soc_e2e.dock import (
    FLIGHT_HEIGHT_M,
    IDLE_SAMPLES,
    RADIUS_M,
    RATE_HZ,
    SPEED_MS,
    announcement,
    osd,
)
from soc_e2e.platform import kong_configuration
from soc_geo.projection import Geodetic, east_north

CENTRE = Geodetic(41.6523, -4.7245)
WIRE = WireContract()


def test_the_dock_announces_its_aircraft_as_so_gateway_does() -> None:
    message = announcement("SOTESTUAV002", 1_790_800_000_000)
    assert WIRE.problems("sys/update_topo", message) == []
    assert [device["sn"] for device in message["data"]["sub_devices"]] == ["SOTESTUAV002"]
    assert message["timestamp"] == 1_790_800_000_000
    assert announcement("SOTESTUAV002", 0)["tid"] != message["tid"]


def test_every_osd_follows_the_contract_idle_then_flying() -> None:
    for index in (0, IDLE_SAMPLES - 1, IDLE_SAMPLES, 400):
        message = osd("SOTESTDOCK01", CENTRE, index, 1_790_800_000_000 + index * 200)
        assert WIRE.problems("osd/aircraft", message) == [], index
    idle = osd("SOTESTDOCK01", CENTRE, 0, 0)["data"]
    flying = osd("SOTESTDOCK01", CENTRE, IDLE_SAMPLES, 0)["data"]
    assert (idle["mode_code"], idle["elevation"]) == (0, 0.0)
    assert (flying["mode_code"], flying["elevation"]) == (5, FLIGHT_HEIGHT_M)


def test_the_flight_circles_the_centre_at_its_radius_and_speed() -> None:
    def where(index: int) -> tuple[float, float]:
        data = osd("SOTESTDOCK01", CENTRE, index, 0)["data"]
        point = east_north(CENTRE, Geodetic(data["latitude"], data["longitude"]))
        return point.east_m, point.north_m

    for index in (0, 37, 250):
        assert math.isclose(math.hypot(*where(index)), RADIUS_M, abs_tol=0.01)
    a, b = where(IDLE_SAMPLES + 10), where(IDLE_SAMPLES + 11)
    assert math.isclose(math.dist(a, b), SPEED_MS / RATE_HZ, rel_tol=0.01)
    assert where(0) == where(IDLE_SAMPLES)


def test_kong_routes_each_service_as_supabase_does() -> None:
    configuration = kong_configuration("auth", "rest", "realtime-dev.realtime")
    routes = {
        service["routes"][0]["paths"][0]: (service["url"], service["routes"][0]["strip_path"])
        for service in configuration["services"]
    }
    assert routes == {
        "/auth/v1/": ("http://auth:9999/", True),
        "/rest/v1/": ("http://rest:3000/", True),
        "/realtime/v1/": ("http://realtime-dev.realtime:4000/socket/", True),
    }
    assert all(service["plugins"] == [{"name": "cors"}] for service in configuration["services"])
