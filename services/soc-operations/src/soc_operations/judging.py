"""The checks of one operation, judged from what the store read of it (FR-OPS-05, ADR-0025).

The store reads the operation and what soc-cloud recorded of its stack and aircraft; this
hands them to soc_operations.checks in its terms. PF-WAYLINE is the validation of the flight
the console stored (soc_operations.validation), against the stack's envelope as last read.
"""

from __future__ import annotations

from datetime import datetime
from typing import cast

from soc_operations import checks, store
from soc_operations.settings import Tunables
from soc_operations.validation import envelope_of, flight_problems


def judged(loaded: store.Loaded, tunables: Tunables, now: datetime) -> tuple[checks.Check, ...]:
    snapshot = loaded.snapshot
    view = snapshot.view
    geofence = view.geofence
    assignment = view.assignments[0] if view.assignments else None
    stack = loaded.stack
    aircraft = loaded.aircraft
    return checks.judge(
        checks.Inputs(
            now=now,
            stack=None
            if stack is None
            else checks.StackView(
                link_state=stack.link_state,
                status=stack.status,
                status_read_at=stack.status_read_at,
                envelope=stack.envelope,
                envelope_read_at=stack.envelope_read_at,
            ),
            aircraft=None
            if aircraft is None
            else checks.AircraftView(
                online=aircraft.online, sample=aircraft.sample, received_at=aircraft.received_at
            ),
            geofence_ring=[] if geofence is None else geofence.polygon,
            geofence_max_height_m=float("nan") if geofence is None else geofence.max_height_m,
            takeoff=None if assignment is None else assignment.wayline.takeoff,
            wayline_problems=None
            if assignment is None
            else flight_problems(view, assignment, envelope_of(snapshot.envelope)),
            dry_run=None
            if loaded.dry_run is None
            else checks.DryRun(
                status=cast(checks.DryRunStatus, loaded.dry_run.status),
                verdict=loaded.dry_run.verdict,
            ),
            stack_busy=loaded.stack_busy,
            tunables=tunables,
        )
    )
