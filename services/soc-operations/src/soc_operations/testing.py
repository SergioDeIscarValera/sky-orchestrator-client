"""Fixtures soc-operations' tests share: the golden route, flown, and a stack that judges it."""

from __future__ import annotations

import copy
import dataclasses
import json
from pathlib import Path
from typing import Any

from soc_operations.validation import (
    AssignmentView,
    FleetView,
    GeofenceView,
    OperationView,
    WaylineView,
)

REPOSITORY = Path(__file__).resolve().parents[4]
# The golden pair: the route example's bake, and the flight an operation at 20 m and 5 m/s
# makes of it (contracts/flight-files/README.md).
ROUTE = json.loads(
    (REPOSITORY / "contracts" / "geometry" / "examples" / "design.route.json").read_text("utf-8")
)
FLIGHT: dict[str, Any] = json.loads(
    (REPOSITORY / "contracts" / "flight-files" / "route-return-home" / "flight.json").read_text(
        "utf-8"
    )
)
#: Round the route, with room: the takeoff and every waypoint well inside.
SQUARE = [[-4.7250, 41.6519], [-4.7235, 41.6519], [-4.7235, 41.6529], [-4.7250, 41.6529]]
ENVELOPE: dict[str, Any] = {
    "envelope": {
        "geofence_center": {"latitude_deg": 41.6523, "longitude_deg": -4.7245},
        "geofence_radius_m": 1000.0,
        "max_height_m": 120.0,
        "max_home_distance_m": 1000.0,
        "max_leg_m": 500.0,
        "max_transit_m": 1000.0,
        "max_total_distance_m": 5000.0,
        "max_waypoints": 200,
        "max_horizontal_speed_ms": 15.0,
    },
    "envelope_fingerprint": "0" * 64,
    "config_fingerprint": "1" * 64,
    "application_in_force": None,
}


def operation(**changes: Any) -> OperationView:
    wayline = WaylineView(
        name="Route", takeoff=ROUTE["design"]["takeoff"], waypoints=ROUTE["baked"]["waypoints"],
        retired=False,
    )  # fmt: skip
    assignment = AssignmentView(
        speed_ms=5.0, flight=copy.deepcopy(FLIGHT), wayline=wayline,
        fleet=FleetView(name="Norte 1", retired=False),
    )  # fmt: skip
    base = OperationView(
        name="Norte", takeoff_security_height_m=20.0,
        geofence=GeofenceView(polygon=SQUARE, max_height_m=60.0, retired=False),
        assignments=[assignment], pilots=1,
    )  # fmt: skip
    return dataclasses.replace(base, **changes)
