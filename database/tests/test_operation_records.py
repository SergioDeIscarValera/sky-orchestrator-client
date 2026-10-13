from __future__ import annotations

import asyncio
import json
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from soc_database.harness import EphemeralPostgres, Operations, Tenancy

RECORD_SAMPLE = "select soc.record_aircraft_sample($1, $2, $3::jsonb, $4)"
RECORD_STACK = {
    "status": "select soc.record_stack_status($1, $2::jsonb)",
    "envelope": "select soc.record_stack_envelope($1, $2::jsonb)",
}
READ_STACK = {
    "status": "select status, status_read_at from soc.stacks where gateway_sn = $1",
    "envelope": "select envelope, envelope_read_at from soc.stacks where gateway_sn = $1",
}
RECORD_PROGRESS = (
    "select soc.record_flight_progress($1, $2::soc.flight_status, $3, $4, $5, $6::jsonb)"
)
RECORD_PROGRESS_ENDED = (
    "select soc.record_flight_progress($1, $2::soc.flight_status, $3, $4, $5, $6::jsonb,"
    " $7::soc.end_reason)"
)
ENTRIES_OF_FLIGHT = (
    "select kind, severity::text as severity, occurred_at, source::text as source, payload"
    " from soc.operation_events where flight_id = $1 and kind in"
    " ('took_off', 'landed', 'automatic_return', 'flight_status_changed') order by occurred_at"
)
JUDGE = "select * from soc.record_dry_run($1, $2::soc.dry_run_status, $3::jsonb)"
RECORD_CHECKS = "select soc.record_checks($1, $2::jsonb)"
RECORD_FILES_URL = "select soc.record_stack_files_url($1, $2)"
CHECK_JUDGED_AT = "2026-10-13T10:00:00+00:00"
NOW = datetime(2026, 10, 13, 10, 0, 0, tzinfo=UTC)
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


@pytest.fixture
async def soc_cloud(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_cloud", service_passwords["soc_cloud"])
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
async def soc_operations(
    migrated: EphemeralPostgres, service_passwords: dict[str, str]
) -> AsyncIterator[asyncpg.Connection]:
    connection = await migrated.connect("soc_operations", service_passwords["soc_operations"])
    try:
        yield connection
    finally:
        await connection.close()


@asynccontextmanager
async def listening(migrated: EphemeralPostgres, channel: str) -> AsyncIterator[asyncio.Queue[str]]:
    """The payloads of the channel's notifications, in the order the database delivers them."""
    heard: asyncio.Queue[str] = asyncio.Queue()
    listener = await migrated.connect()
    try:
        await listener.add_listener(channel, lambda *arguments: heard.put_nowait(arguments[3]))
        yield heard
    finally:
        await listener.close()


async def heard_in_order(heard: asyncio.Queue[str], count: int) -> list[str]:
    return [await asyncio.wait_for(heard.get(), 5) for _ in range(count)]


async def stack_in(soc_cloud: asyncpg.Connection, organization_id: uuid.UUID) -> str:
    gateway = f"SOTEST{secrets.token_hex(4).upper()}"
    await soc_cloud.execute(
        "select soc.record_stack($1, 'lab', $2, 'connected')", gateway, organization_id
    )
    return gateway


def aircraft_sn() -> str:
    return f"SOUAV{secrets.token_hex(4).upper()}"


def judgement(
    check_id: str,
    state: str,
    *,
    value: dict[str, Any] | None = None,
    at: str = CHECK_JUDGED_AT,
) -> dict[str, Any]:
    return {
        "check_id": check_id,
        "state": state,
        "blocking": True,
        "value": value,
        "detail": None,
        "evaluated_at": at,
    }


async def test_the_latest_aircraft_sample_is_kept_and_an_older_one_is_ignored(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    gateway = await stack_in(soc_cloud, member.organization_id)
    aircraft = aircraft_sn()
    async with listening(migrated, "soc_aircraft_samples") as heard:
        await soc_cloud.execute(RECORD_SAMPLE, aircraft, gateway, json.dumps({"height_m": 30}), NOW)
        await soc_cloud.execute(
            RECORD_SAMPLE,
            aircraft,
            gateway,
            json.dumps({"height_m": 10}),
            NOW - timedelta(seconds=5),
        )
        await soc_cloud.execute(
            RECORD_SAMPLE,
            aircraft,
            gateway,
            json.dumps({"height_m": 45}),
            NOW + timedelta(seconds=1),
        )
        assert await heard_in_order(heard, 3) == [aircraft, aircraft, aircraft]
    row = await admin.fetchrow(
        "select sample, sampled_at, organization_id from soc.aircraft_samples"
        " where aircraft_sn = $1",
        aircraft,
    )
    assert row is not None
    assert json.loads(row["sample"]) == {"height_m": 45}
    assert row["sampled_at"] == NOW + timedelta(seconds=1)
    assert row["organization_id"] == member.organization_id


@pytest.mark.parametrize("field", ["status", "envelope"])
async def test_a_stack_value_is_kept_with_when_it_was_read_and_null_is_unknown(
    field: str,
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    gateway = await stack_in(soc_cloud, member.organization_id)
    other = await stack_in(soc_cloud, member.organization_id)
    async with listening(migrated, "soc_stack_views") as heard:
        await soc_cloud.execute(RECORD_STACK[field], gateway, json.dumps({"value": 1}))
        first = await admin.fetchrow(READ_STACK[field], gateway)
        await soc_cloud.execute(RECORD_STACK[field], gateway, json.dumps({"value": 1}))
        same = await admin.fetchrow(READ_STACK[field], gateway)
        await soc_cloud.execute(RECORD_STACK[field], gateway, None)
        unknown = await admin.fetchrow(READ_STACK[field], gateway)
        await soc_cloud.execute(RECORD_STACK[field], gateway, None)
        await soc_cloud.execute(RECORD_STACK[field], other, json.dumps({"value": 2}))
        assert await heard_in_order(heard, 3) == [gateway, gateway, other]
        assert heard.empty()
    assert first is not None and same is not None and unknown is not None
    assert json.loads(first[0]) == {"value": 1}
    assert same[1] > first[1]
    assert unknown[0] is None
    assert unknown[1] > same[1]


async def test_a_flight_progress_is_kept_and_a_change_of_status_is_logged_and_announced(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    flown = await Operations(admin).flown(member.organization_id)
    async with listening(migrated, "soc_flight_progress") as heard:
        for status, percent in [
            ("in_progress", 10),
            ("in_progress", 20),
            ("paused", 20),
            ("ok", 100),
        ]:
            await soc_cloud.execute(RECORD_PROGRESS, flown.flight_id, status, 0, percent, 3, None)
        assert await heard_in_order(heard, 3) == [str(flown.flight_id)] * 3
        assert heard.empty()
    entries = await admin.fetch(ENTRIES_OF_FLIGHT, flown.flight_id)
    assert [json.loads(entry["payload"])["status"] for entry in entries] == [
        "in_progress",
        "paused",
        "ok",
    ]
    state = await admin.fetchrow(
        "select status::text as status, percent, end_reason from soc.flight_states"
        " where flight_id = $1",
        flown.flight_id,
    )
    assert state is not None
    assert (state["status"], state["percent"], state["end_reason"]) == ("ok", 100, None)


async def test_a_flight_progress_keeps_how_the_task_ended_on_the_row_the_log_and_the_broadcast(
    todays_partition: None,
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("owner")
    flown = await Operations(admin).flown(member.organization_id)
    await soc_cloud.execute(
        RECORD_PROGRESS_ENDED, flown.flight_id, "canceled", 0, 50, 3, None, "geofence_breach"
    )
    state = await admin.fetchval(
        "select end_reason::text from soc.flight_states where flight_id = $1", flown.flight_id
    )
    assert state == "geofence_breach"
    entries = await admin.fetch(ENTRIES_OF_FLIGHT, flown.flight_id)
    assert json.loads(entries[-1]["payload"])["end_reason"] == "geofence_breach"
    broadcast = await admin.fetch(
        "select payload from realtime.messages where topic = $1 and event = 'flight_state'"
        " order by inserted_at, id",
        f"org:{member.organization_id}:soc:state",
    )
    assert json.loads(broadcast[-1]["payload"])["end_reason"] == "geofence_breach"


async def test_a_flight_moment_is_logged_and_the_take_off_is_kept_once(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("owner")
    flown = await Operations(admin).flown(member.organization_id)
    moments = [
        ("took_off", NOW),
        ("took_off", NOW + timedelta(seconds=60)),
        ("landed", NOW + timedelta(seconds=120)),
        ("automatic_return", NOW + timedelta(seconds=130)),
    ]
    for moment, at in moments:
        await soc_cloud.execute(
            "select soc.record_flight_moment($1, $2, $3, 1)", flown.flight_id, moment, at
        )
    row = await admin.fetchrow(
        "select took_off_at, landed_at from soc.flights where id = $1", flown.flight_id
    )
    assert row is not None
    assert (row["took_off_at"], row["landed_at"]) == (NOW, NOW + timedelta(seconds=120))
    entries = await admin.fetch(ENTRIES_OF_FLIGHT, flown.flight_id)
    assert [(entry["kind"], entry["occurred_at"], entry["source"]) for entry in entries] == [
        ("took_off", NOW, "aircraft"),
        ("took_off", NOW + timedelta(seconds=60), "aircraft"),
        ("landed", NOW + timedelta(seconds=120), "aircraft"),
        ("automatic_return", NOW + timedelta(seconds=130), "aircraft"),
    ]
    assert [entry["severity"] for entry in entries] == ["info", "info", "info", "warning"]
    assert json.loads(entries[0]["payload"]) == {"mode_code": 1}


async def test_a_flight_moment_is_one_of_three_moments(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    with pytest.raises(asyncpg.InvalidParameterValueError):
        await soc_cloud.execute(
            "select soc.record_flight_moment($1, 'crashed', now(), 1)", flown.flight_id
        )


async def test_a_dry_run_is_announced_when_it_is_asked(
    admin: asyncpg.Connection, tenancy: Tenancy, migrated: EphemeralPostgres
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    async with listening(migrated, "soc_dry_runs") as heard:
        run = await admin.fetchval(
            "insert into soc.dry_runs (organization_id, file_id, gateway_sn)"
            " values ($1, $2, $3) returning id",
            flown.organization_id,
            flown.file_id,
            flown.gateway_sn,
        )
        assert await asyncio.wait_for(heard.get(), 5) == str(run)


async def test_a_dry_run_is_judged_once_and_its_judgement_is_announced(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    first = await admin.fetchval(
        "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)"
        " returning id",
        flown.organization_id,
        flown.file_id,
        flown.gateway_sn,
    )
    second = await admin.fetchval(
        "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)"
        " returning id",
        flown.organization_id,
        flown.file_id,
        flown.gateway_sn,
    )
    async with listening(migrated, "soc_dry_run_results") as heard:
        judged = await soc_cloud.fetch(JUDGE, first, "valid", json.dumps({"problems": []}))
        again = await soc_cloud.fetch(JUDGE, first, "rejected", json.dumps({"problems": ["x"]}))
        await soc_cloud.fetch(JUDGE, second, "rejected", json.dumps({"problems": ["y"]}))
        assert await heard_in_order(heard, 2) == [str(first), str(second)]
        assert heard.empty()
    assert [(row["status"], json.loads(row["verdict"])) for row in judged] == [
        ("valid", {"problems": []})
    ]
    assert again == []


async def test_a_dry_run_cannot_be_judged_pending(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    run = await admin.fetchval(
        "insert into soc.dry_runs (organization_id, file_id, gateway_sn) values ($1, $2, $3)"
        " returning id",
        flown.organization_id,
        flown.file_id,
        flown.gateway_sn,
    )
    with pytest.raises(asyncpg.InvalidParameterValueError):
        await soc_cloud.fetch(JUDGE, run, "pending", "{}")


async def test_record_checks_writes_only_what_changed_and_broadcasts_each_write(
    todays_partition: None,
    soc_operations: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
) -> None:
    member = await tenancy.member("owner")
    flown = await Operations(admin).flown(member.organization_id)
    link = judgement("PF-LINK", "pass")
    battery = judgement("PF-BATTERY", "fail", value={"percent": 12})
    assert (
        await soc_operations.fetchval(
            RECORD_CHECKS, flown.operation_id, json.dumps([link, battery])
        )
        == 2
    )
    assert (
        await soc_operations.fetchval(
            RECORD_CHECKS, flown.operation_id, json.dumps([link, battery])
        )
        == 0
    )
    changed = judgement("PF-LINK", "fail", at="2026-10-13T10:00:02+00:00")
    assert (
        await soc_operations.fetchval(RECORD_CHECKS, flown.operation_id, json.dumps([changed])) == 1
    )
    moved_only = judgement("PF-LINK", "fail", at="2026-10-13T10:00:05+00:00")
    assert (
        await soc_operations.fetchval(RECORD_CHECKS, flown.operation_id, json.dumps([moved_only]))
        == 0
    )
    stored = await admin.fetchrow(
        "select state::text as state, evaluated_at from soc.operation_checks"
        " where operation_id = $1 and check_id = 'PF-LINK'",
        flown.operation_id,
    )
    assert stored is not None
    assert stored["state"] == "fail"
    assert stored["evaluated_at"] == datetime(2026, 10, 13, 10, 0, 2, tzinfo=UTC)
    broadcast = await admin.fetch(
        "select payload from realtime.messages where topic = $1 and event = 'operation_check'",
        f"org:{member.organization_id}:soc:state",
    )
    assert len(broadcast) == 3


@pytest.mark.parametrize("check_id", ["BAT-1", "PF-1", "pf-battery", "PF-"])
async def test_a_check_id_not_shaped_pf_is_refused(
    check_id: str, soc_operations: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await soc_operations.fetchval(
            RECORD_CHECKS, flown.operation_id, json.dumps([judgement(check_id, "pass")])
        )
    assert refusal.value.constraint_name == "operation_check_named"


async def test_a_stacks_flight_files_url_is_http_or_null(
    soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    member = await tenancy.member("owner")
    gateway = await stack_in(soc_cloud, member.organization_id)
    url = "http://192.168.1.10:8080/files"
    await soc_cloud.execute(RECORD_FILES_URL, gateway, url)
    assert (
        await admin.fetchval(
            "select flight_files_url from soc.stacks where gateway_sn = $1", gateway
        )
        == url
    )
    await soc_cloud.execute(RECORD_FILES_URL, gateway, None)
    assert (
        await admin.fetchval(
            "select flight_files_url from soc.stacks where gateway_sn = $1", gateway
        )
        is None
    )
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await soc_cloud.execute(RECORD_FILES_URL, gateway, "https://files.example.test/")
    assert refusal.value.constraint_name == "stack_flight_files_url"


@pytest.mark.parametrize("status", ["sent", "in_progress", "paused"])
async def test_a_flight_state_ends_only_once_its_status_is_a_finished_one(
    status: str, soc_cloud: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await soc_cloud.execute(
            RECORD_PROGRESS_ENDED, flown.flight_id, status, 0, 40, 2, None, "geofence_breach"
        )
    assert refusal.value.constraint_name == "flight_state_ends_when_finished"


async def test_a_progress_on_an_ended_flight_is_kept_but_neither_logged_nor_announced(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    ended = await Operations(admin).flown(member.organization_id)
    still_flying = await Operations(admin).flown(member.organization_id)
    await admin.execute(
        "update soc.flights set ended_at = now(), end_reason = 'operator_return' where id = $1",
        ended.flight_id,
    )
    async with listening(migrated, "soc_flight_progress") as heard:
        await soc_cloud.execute(RECORD_PROGRESS, ended.flight_id, "paused", 0, 40, 2, None)
        await soc_cloud.execute(
            RECORD_PROGRESS, still_flying.flight_id, "in_progress", 0, 10, 1, None
        )
        assert await heard_in_order(heard, 1) == [str(still_flying.flight_id)]
        assert heard.empty()
    kept = await admin.fetchval(
        "select status::text from soc.flight_states where flight_id = $1", ended.flight_id
    )
    assert kept == "paused"
    logged = await admin.fetchval(
        "select count(*) from soc.operation_events where flight_id = $1"
        " and kind = 'flight_status_changed'",
        ended.flight_id,
    )
    assert logged == 0


async def test_a_progress_on_a_closed_operation_is_kept_but_neither_logged_nor_announced(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    closed = await Operations(admin).flown(member.organization_id)
    still_flying = await Operations(admin).flown(member.organization_id)
    await Operations(admin).move(closed.operation_id, *TO_COMPLETED)
    async with listening(migrated, "soc_flight_progress") as heard:
        await soc_cloud.execute(RECORD_PROGRESS, closed.flight_id, "paused", 0, 40, 2, None)
        await soc_cloud.execute(
            RECORD_PROGRESS, still_flying.flight_id, "in_progress", 0, 10, 1, None
        )
        assert await heard_in_order(heard, 1) == [str(still_flying.flight_id)]
        assert heard.empty()
    assert (
        await admin.fetchval(
            "select status::text from soc.flight_states where flight_id = $1", closed.flight_id
        )
        == "paused"
    )
    assert (
        await admin.fetchval(
            "select count(*) from soc.operation_events where flight_id = $1", closed.flight_id
        )
        == 0
    )


async def test_a_moment_on_a_closed_operation_is_kept_on_the_flight_but_not_logged(
    soc_cloud: asyncpg.Connection,
    admin: asyncpg.Connection,
    tenancy: Tenancy,
    migrated: EphemeralPostgres,
) -> None:
    member = await tenancy.member("owner")
    closed = await Operations(admin).flown(member.organization_id)
    still_flying = await Operations(admin).flown(member.organization_id)
    await Operations(admin).move(closed.operation_id, *TO_COMPLETED)
    async with listening(migrated, "soc_flight_progress") as heard:
        await soc_cloud.execute(
            "select soc.record_flight_moment($1, 'took_off', $2, 1)", closed.flight_id, NOW
        )
        await soc_cloud.execute(
            RECORD_PROGRESS, still_flying.flight_id, "in_progress", 0, 10, 1, None
        )
        assert await heard_in_order(heard, 1) == [str(still_flying.flight_id)]
        assert heard.empty()
    assert (
        await admin.fetchval("select took_off_at from soc.flights where id = $1", closed.flight_id)
        == NOW
    )
    assert (
        await admin.fetchval(
            "select count(*) from soc.operation_events where flight_id = $1 and kind = 'took_off'",
            closed.flight_id,
        )
        == 0
    )


async def test_record_checks_refuses_a_write_on_a_closed_operation(
    soc_operations: asyncpg.Connection, admin: asyncpg.Connection, tenancy: Tenancy
) -> None:
    flown = await Operations(admin).flown((await tenancy.member("owner")).organization_id)
    await Operations(admin).move(flown.operation_id, *TO_COMPLETED)
    with pytest.raises(asyncpg.CheckViolationError) as refusal:
        await soc_operations.fetchval(
            RECORD_CHECKS, flown.operation_id, json.dumps([judgement("PF-LINK", "pass")])
        )
    assert refusal.value.constraint_name == "operation_closed"
