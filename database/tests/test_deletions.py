from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from soc_database.harness import Member, Operations, Tenancy, impersonate

# Every table that holds rows of an organization, keyed by its organization column.
HELD_FOR_AN_ORGANIZATION = [
    "soc.operations",
    "soc.assignments",
    "soc.operators",
    "soc.flight_files",
    "soc.flights",
    "soc.flight_states",
    "soc.operation_events",
    "soc.telemetry_samples",
    "soc.operation_checks",
    "soc.dry_runs",
    "soc.transition_requests",
    "soc.command_intents",
    "soc.stacks",
    "soc.fleets",
]
TO_COMPLETED = [
    "planned",
    "preparing",
    "simulating",
    "simulated",
    "ready",
    "launching",
    "in_flight",
    "returning",
    "completed",
]


@asynccontextmanager
async def committed_as(
    session: asyncpg.Connection, user: uuid.UUID
) -> AsyncIterator[asyncpg.Connection]:
    """Acts as the user and keeps what was done, as a request through PostgREST does."""
    async with session.transaction():
        await impersonate(session, user)
        yield session


async def member_in(tenancy: Tenancy, organization_id: uuid.UUID, role: str) -> Member:
    member = Member(await tenancy.user(), organization_id)
    await tenancy.join(member.user_id, organization_id, role)
    return member


@pytest.mark.parametrize("states", [TO_COMPLETED[:7], TO_COMPLETED], ids=["flying", "closed"])
async def test_deleting_a_user_is_never_blocked_and_takes_their_operators(
    states: list[str], admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    pilot = await member_in(tenancy, owner.organization_id, "editor")
    flown = await Operations(admin).flown(owner.organization_id)
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, 'pilot')",
        flown.operation_id,
        owner.organization_id,
        pilot.user_id,
    )
    await Operations(admin).move(flown.operation_id, *states)
    await admin.execute("delete from auth.users where id = $1", pilot.user_id)
    remaining = await admin.fetchval(
        "select count(*) from soc.operators where profile_id = $1", pilot.user_id
    )
    assert remaining == 0


async def test_a_user_who_made_a_closed_operation_is_deleted_and_the_operation_forgets_them(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    creator = await tenancy.member("editor")
    async with committed_as(session, creator.user_id):
        operation = await session.fetchval(
            "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning id",
            creator.organization_id,
        )
    assert isinstance(operation, uuid.UUID)
    await Operations(admin).move(operation, *TO_COMPLETED)
    await admin.execute("delete from auth.users where id = $1", creator.user_id)
    row = await admin.fetchrow(
        "select state::text as state, created_by from soc.operations where id = $1", operation
    )
    assert row is not None
    assert (row["state"], row["created_by"]) == ("completed", None)


async def test_a_membership_removed_from_the_organization_takes_its_operators_in_a_closed_operation(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    pilot = await member_in(tenancy, owner.organization_id, "editor")
    flown = await Operations(admin).flown(owner.organization_id)
    await admin.execute(
        "insert into soc.operators (operation_id, organization_id, profile_id, role)"
        " values ($1, $2, $3, 'pilot')",
        flown.operation_id,
        owner.organization_id,
        pilot.user_id,
    )
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    await admin.execute(
        "delete from public.memberships where organization_id = $1 and profile_id = $2",
        owner.organization_id,
        pilot.user_id,
    )
    remaining = await admin.fetchval(
        "select count(*) from soc.operators where operation_id = $1", flown.operation_id
    )
    assert remaining == 0


async def test_deleting_an_organization_takes_an_operation_and_its_log(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    organization = owner.organization_id
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning id",
        organization,
    )
    assert isinstance(operation, uuid.UUID)
    await Operations(admin).move(operation, *TO_COMPLETED)
    assert (
        await admin.fetchval(
            "select count(*) from soc.operation_events where operation_id = $1", operation
        )
        > 0
    )
    await admin.execute("delete from public.organizations where id = $1", organization)
    for table in ("soc.operations", "soc.operation_events"):
        count = await admin.fetchval(
            f"select count(*) from {table} where organization_id = $1",  # noqa: S608 - fixed names
            organization,
        )
        assert count == 0, table


@pytest.mark.xfail(
    strict=True,
    raises=asyncpg.ForeignKeyViolationError,
    reason="Decision B says deleting an organization takes a whole operation with its log. A "
    "flown operation still refuses it with assignments_wayline_id_organization_id_fkey: its "
    "assignment names a wayline the cascade removes, and 0010 leaves the wayline, fleet and "
    "assignment keys without a cascade",
)
async def test_deleting_an_organization_takes_a_flown_operation_its_flights_and_its_log(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    organization = owner.organization_id
    flown = await Operations(admin).flown(organization)
    await admin.execute(
        "insert into soc.flight_states (flight_id, organization_id, status)"
        " values ($1, $2, 'paused')",
        flown.flight_id,
        organization,
    )
    await admin.execute(
        "insert into soc.telemetry_samples (flight_id, sampled_at, organization_id, fleet_id,"
        " received_at, longitude, latitude, height_m)"
        " values ($1, now(), $2, $3, now(), -4.72, 41.65, 30)",
        flown.flight_id,
        organization,
        flown.fleet_id,
    )
    await admin.execute(
        "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)",
        organization,
        flown.file_id,
        flown.gateway_sn,
    )
    await admin.execute(
        "insert into soc.command_intents"
        " (client_request_id, organization_id, operation_id, flight_id, gateway_sn, verb)"
        " values ($1, $2, $3, $4, $5, 'pause')",
        uuid.uuid4(),
        organization,
        flown.operation_id,
        flown.flight_id,
        flown.gateway_sn,
    )
    await admin.execute(
        "insert into soc.transition_requests (client_request_id, organization_id, operation_id,"
        " transition) values ($1, $2, $3, 'cancel')",
        uuid.uuid4(),
        organization,
        flown.operation_id,
    )
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    assert (
        await admin.fetchval(
            "select count(*) from soc.operation_events where organization_id = $1", organization
        )
        > 0
    )
    await admin.execute("delete from public.organizations where id = $1", organization)
    for table in HELD_FOR_AN_ORGANIZATION:
        count = await admin.fetchval(
            f"select count(*) from {table} where organization_id = $1",  # noqa: S608 - fixed names
            organization,
        )
        assert count == 0, table


async def test_the_log_of_an_organization_that_is_still_there_is_not_erased_by_a_direct_delete(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    entry = await admin.fetchval(
        "select id from soc.operation_events where operation_id = $1 limit 1", flown.operation_id
    )
    with pytest.raises(asyncpg.InsufficientPrivilegeError) as refusal:
        await admin.execute("delete from soc.operation_events where id = $1", entry)
    assert "append-only" in refusal.value.message
