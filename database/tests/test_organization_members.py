from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as

LISTED = (
    "select profile_id, display_name, email::text as email, role::text as role"
    " from soc.organization_members($1)"
)


@pytest.fixture
async def soc_cloud(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
    try:
        yield connection
    finally:
        await connection.close()


async def join_named(
    tenancy: Tenancy,
    admin: asyncpg.Connection,
    organization_id: uuid.UUID,
    role: str,
    display_name: str | None,
    email: str | None = None,
) -> Member:
    """A user who is a member of the organization, with a name and, optionally, an email."""
    user_id = await tenancy.user()
    await tenancy.join(user_id, organization_id, role)
    await admin.execute(
        "update public.profiles set display_name = $2, email = coalesce($3, email) where id = $1",
        user_id,
        display_name,
        email,
    )
    return Member(user_id, organization_id)


async def test_a_member_sees_exactly_the_live_members_in_name_order(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    organization = owner.organization_id
    await admin.execute(
        "update public.profiles set display_name = 'Dani' where id = $1", owner.user_id
    )
    viewer = await join_named(tenancy, admin, organization, "viewer", "Carla")
    caller = await join_named(tenancy, admin, organization, "editor", "Bruno")
    unnamed = await join_named(tenancy, admin, organization, "viewer", None, "zoe@soc.test")
    retired_membership = await join_named(tenancy, admin, organization, "editor", "Ana")
    retired_profile = await join_named(tenancy, admin, organization, "editor", "Eva")
    await tenancy.soft_delete_membership(retired_membership)
    await admin.execute(
        "update public.profiles set deleted_at = now() where id = $1", retired_profile.user_id
    )
    outsider = await tenancy.member("editor")
    async with acting_as(session, caller.user_id) as connection:
        rows = await connection.fetch(LISTED, organization)
    assert [(row["display_name"], row["role"]) for row in rows] == [
        ("Bruno", "editor"),
        ("Carla", "viewer"),
        ("Dani", "owner"),
        (None, "viewer"),
    ]
    assert [row["profile_id"] for row in rows] == [
        caller.user_id,
        viewer.user_id,
        owner.user_id,
        unnamed.user_id,
    ]
    assert rows[-1]["email"] == "zoe@soc.test"
    assert outsider.user_id not in {row["profile_id"] for row in rows}
    assert retired_membership.user_id not in {row["profile_id"] for row in rows}
    assert retired_profile.user_id not in {row["profile_id"] for row in rows}


async def test_a_member_of_another_organization_gets_nothing(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member("owner")).organization_id
    stranger = await tenancy.member("editor")
    async with acting_as(session, stranger.user_id) as connection:
        rows = await connection.fetch(LISTED, organization)
    assert rows == []


async def test_a_user_who_is_no_member_gets_nothing(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member("owner")).organization_id
    nobody = await tenancy.user()
    async with acting_as(session, nobody) as connection:
        rows = await connection.fetch(LISTED, organization)
    assert rows == []


async def test_a_retired_membership_gets_nothing_from_the_organization(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    retired = await join_named(tenancy, admin, owner.organization_id, "editor", "Ana")
    await tenancy.soft_delete_membership(retired)
    async with acting_as(session, retired.user_id) as connection:
        rows = await connection.fetch(LISTED, owner.organization_id)
    assert rows == []


async def test_a_retired_organization_lists_nobody(
    session: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    editor = await join_named(tenancy, admin, owner.organization_id, "editor", "Bruno")
    await tenancy.soft_delete_organization(owner.organization_id)
    async with acting_as(session, editor.user_id) as connection:
        rows = await connection.fetch(LISTED, owner.organization_id)
    assert rows == []


async def test_only_authenticated_may_execute_the_list(
    admin: asyncpg.Connection, soc_cloud: asyncpg.Connection, tenancy: Tenancy
) -> None:
    organization = (await tenancy.member("owner")).organization_id
    signature = "soc.organization_members(uuid)"
    for role, may in [
        ("authenticated", True),
        ("soc_cloud", False),
        ("soc_operations", False),
        ("anon", False),
    ]:
        granted = await admin.fetchval(
            "select has_function_privilege($1, $2::regprocedure, 'EXECUTE')", role, signature
        )
        assert granted is may, role
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.fetch(LISTED, organization)
