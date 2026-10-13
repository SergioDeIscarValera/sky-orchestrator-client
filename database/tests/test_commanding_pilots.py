from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Member, Tenancy, acting_as

COUNT = "select soc.commanding_pilots($1)"
ADD_OPERATOR = (
    "insert into soc.operators (operation_id, organization_id, profile_id, role)"
    " values ($1, $2, $3, $4::soc.operator_role)"
)


@pytest.fixture
async def soc_operations(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_operations", service_passwords["soc_operations"])
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
async def soc_cloud(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
    try:
        yield connection
    finally:
        await connection.close()


async def operation_in(admin: asyncpg.Connection, organization_id: uuid.UUID) -> uuid.UUID:
    operation = await admin.fetchval(
        "insert into soc.operations (organization_id, name) values ($1, 'Norte') returning id",
        organization_id,
    )
    assert isinstance(operation, uuid.UUID)
    return operation


async def member_with(tenancy: Tenancy, organization_id: uuid.UUID, role: str) -> Member:
    member = Member(await tenancy.user(), organization_id)
    await tenancy.join(member.user_id, organization_id, role)
    return member


@pytest.mark.parametrize(
    ("member_role", "operator_role", "retire", "counted"),
    [
        pytest.param("editor", "pilot", None, 1, id="editor-pilot"),
        pytest.param("owner", "pilot", None, 1, id="owner-pilot"),
        pytest.param("viewer", "pilot", None, 0, id="viewer-pilot"),
        pytest.param("editor", "observer", None, 0, id="editor-observer"),
        pytest.param("editor", "pilot", "membership", 0, id="removed-membership"),
        pytest.param("editor", "pilot", "organization", 0, id="retired-organization"),
    ],
)
async def test_only_a_live_editor_or_owner_who_pilots_the_operation_counts(
    member_role: str,
    operator_role: str,
    retire: str | None,
    counted: int,
    admin: asyncpg.Connection,
    soc_operations: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    owner = await tenancy.member("owner")
    operation = await operation_in(admin, owner.organization_id)
    member = await member_with(tenancy, owner.organization_id, member_role)
    await admin.execute(
        ADD_OPERATOR, operation, owner.organization_id, member.user_id, operator_role
    )
    if retire == "membership":
        await tenancy.soft_delete_membership(member)
    elif retire == "organization":
        await tenancy.soft_delete_organization(owner.organization_id)
    assert await soc_operations.fetchval(COUNT, operation) == counted


async def test_the_count_is_of_the_pilots_who_can_command_among_all_operators(
    admin: asyncpg.Connection, soc_operations: asyncpg.Connection, tenancy: Tenancy
) -> None:
    owner = await tenancy.member("owner")
    organization = owner.organization_id
    operation = await operation_in(admin, organization)
    editor_pilot = await member_with(tenancy, organization, "editor")
    owner_pilot = await member_with(tenancy, organization, "owner")
    viewer_pilot = await member_with(tenancy, organization, "viewer")
    observer = await member_with(tenancy, organization, "editor")
    await admin.execute(ADD_OPERATOR, operation, organization, editor_pilot.user_id, "pilot")
    await admin.execute(ADD_OPERATOR, operation, organization, owner_pilot.user_id, "pilot")
    await admin.execute(ADD_OPERATOR, operation, organization, viewer_pilot.user_id, "pilot")
    await admin.execute(ADD_OPERATOR, operation, organization, observer.user_id, "observer")
    assert await soc_operations.fetchval(COUNT, operation) == 2


async def test_an_operation_without_operators_has_no_commanding_pilot(
    admin: asyncpg.Connection, soc_operations: asyncpg.Connection, tenancy: Tenancy
) -> None:
    operation = await operation_in(admin, (await tenancy.member("owner")).organization_id)
    assert await soc_operations.fetchval(COUNT, operation) == 0


async def test_only_soc_operations_may_execute_the_count(
    admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    signature = "soc.commanding_pilots(uuid)"
    for role, may in [
        ("soc_operations", True),
        ("authenticated", False),
        ("soc_cloud", False),
        ("anon", False),
    ]:
        granted = await admin.fetchval(
            "select has_function_privilege($1, $2::regprocedure, 'EXECUTE')", role, signature
        )
        assert granted is may, role


async def test_authenticated_and_soc_cloud_cannot_execute_the_count(
    session: asyncpg.Connection,
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("editor")
    operation = await operation_in(admin, member.organization_id)
    async with acting_as(session, member.user_id) as connection:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await connection.fetchval(COUNT, operation)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await soc_cloud.fetchval(COUNT, operation)
