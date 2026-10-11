from __future__ import annotations

import uuid

import asyncpg
import pytest

from soc_database.harness import Tenancy, acting_as


async def organizations_of(session: asyncpg.Connection, user: uuid.UUID) -> list[asyncpg.Record]:
    async with acting_as(session, user):
        return await session.fetch("select * from soc.member_organizations()")


async def test_a_member_gets_each_organization_with_their_role_and_its_position(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    user = await tenancy.user()
    farm = await tenancy.organization(user, "Finca Norte", (41.6523, -4.7245), "Europe/Madrid")
    other_owner = await tenancy.user()
    orchard = await tenancy.organization(other_owner, "Almendral")
    await tenancy.join(user, orchard, "viewer")

    rows = await organizations_of(session, user)

    assert [dict(row) for row in rows] == [
        {
            "id": orchard,
            "name": "Almendral",
            "role": "viewer",
            "latitude": None,
            "longitude": None,
            "timezone": None,
        },
        {
            "id": farm,
            "name": "Finca Norte",
            "role": "owner",
            "latitude": 41.6523,
            "longitude": -4.7245,
            "timezone": "Europe/Madrid",
        },
    ]


async def test_other_organizations_stay_out(session: asyncpg.Connection, tenancy: Tenancy) -> None:
    member = await tenancy.member("editor")
    await tenancy.member("owner")
    stranger = await tenancy.user()

    assert [row["id"] for row in await organizations_of(session, member.user_id)] == [
        member.organization_id
    ]
    assert await organizations_of(session, stranger) == []


async def test_a_soft_deleted_organization_is_not_offered(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("viewer")
    await tenancy.soft_delete_organization(member.organization_id)
    assert await organizations_of(session, member.user_id) == []


async def test_a_soft_deleted_membership_is_not_offered(
    session: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("editor")
    await tenancy.soft_delete_membership(member)
    assert await organizations_of(session, member.user_id) == []


async def test_anonymous_callers_cannot_list_organizations(session: asyncpg.Connection) -> None:
    async with acting_as(session, None):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await session.fetch("select * from soc.member_organizations()")
