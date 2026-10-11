from __future__ import annotations

import uuid

import asyncpg
import pytest

from soc_database.harness import Tenancy, acting_as


async def is_live_member(session: asyncpg.Connection, user: uuid.UUID, org: uuid.UUID) -> bool:
    async with acting_as(session, user):
        return bool(await session.fetchval("select soc.is_live_member($1)", org))


async def has_live_role(
    session: asyncpg.Connection, user: uuid.UUID, org: uuid.UUID, minimum: str
) -> bool:
    async with acting_as(session, user):
        return bool(await session.fetchval("select soc.has_live_role($1, $2)", org, minimum))


async def test_a_member_of_a_live_organization_is_a_live_member(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("viewer")
    assert await is_live_member(session, member.user_id, member.organization_id)
    async with acting_as(session, member.user_id):
        assert member.organization_id in await session.fetchval("select soc.live_member_orgs()")


async def test_someone_else_is_not(session: asyncpg.Connection, tenancy: Tenancy) -> None:
    member = await tenancy.member()
    stranger = await tenancy.user()
    assert not await is_live_member(session, stranger, member.organization_id)


async def test_a_soft_deleted_organization_gives_no_access(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    await tenancy.soft_delete_organization(member.organization_id)
    async with acting_as(session, member.user_id):
        assert await session.fetchval("select private.is_member($1)", member.organization_id)
    assert not await is_live_member(session, member.user_id, member.organization_id)
    assert not await has_live_role(session, member.user_id, member.organization_id, "viewer")


async def test_a_soft_deleted_membership_gives_no_access(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    await tenancy.soft_delete_membership(member)
    assert not await is_live_member(session, member.user_id, member.organization_id)


@pytest.mark.parametrize(
    ("role", "minimum", "allowed"),
    [
        ("viewer", "viewer", True),
        ("viewer", "editor", False),
        ("editor", "editor", True),
        ("editor", "owner", False),
        ("owner", "editor", True),
    ],
)
async def test_roles_rank_owner_over_editor_over_viewer(
    session: asyncpg.Connection, tenancy: Tenancy, role: str, minimum: str, allowed: bool
) -> None:
    member = await tenancy.member(role)
    assert await has_live_role(session, member.user_id, member.organization_id, minimum) is allowed


async def test_anonymous_callers_cannot_use_the_helpers(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member()
    async with acting_as(session, None):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await session.fetchval("select soc.is_live_member($1)", member.organization_id)
