from __future__ import annotations

import asyncio
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import aiohttp
import pytest
import websockets
from aiohttp import web

from soc_cloud import probe
from soc_cloud.fanout import EVENT, telemetry_topic
from soc_realtime import Endpoint
from soc_realtime.protocol import TOPIC_PREFIX, Frame, decode
from soc_realtime.testing import FakePhoenix
from soc_supervision import Backoff

ORGANIZATION = uuid.UUID("6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a")
TOPIC = telemetry_topic(ORGANIZATION)
CHANNEL = TOPIC_PREFIX + TOPIC
ANON = secrets.token_hex(16)
MEMBER = probe.Credentials(email=f"{secrets.token_hex(4)}@soc.test", password=secrets.token_hex(16))
STRANGER = probe.Credentials(
    email=f"{secrets.token_hex(4)}@soc.test", password=secrets.token_hex(16)
)


def evidence(**overrides: Any) -> probe.Evidence:
    values: dict[str, Any] = {
        "window_s": 600.0,
        "latencies_ms": (),
        "longest_gap_ms": 0,
        "joins": 1,
        "drops": 0,
        "up_at_end": True,
        "samples_since_join": 0,
        "malformed": 0,
        "verdicts": (),
        "fatal": None,
        "last_error": None,
    }
    return probe.Evidence(**(values | overrides))


def config_for(port: int, *, window_s: float = 0.8, outsider: bool = False) -> probe.Config:
    return probe.Config(
        supabase_url=f"http://127.0.0.1:{port}",
        anon_key=ANON,
        organization=ORGANIZATION,
        window_s=window_s,
        max_p95_ms=150,
        member=MEMBER,
        outsider=STRANGER if outsider else None,
    )


def outsider_for(port: int, signin: FakeSignIn | None = None) -> probe.Outsider:
    return probe.Outsider(
        endpoint=Endpoint(f"http://127.0.0.1:{port}/realtime/v1", ANON),
        topic=TOPIC,
        session=probe.Session(signin or FakeSignIn(), STRANGER),
        connector=websockets.connect,
    )


def fast_backoff() -> Backoff:
    return Backoff(initial_s=0.01, cap_s=0.05)


class FakeSignIn:
    """GoTrue as the gate fakes it: a token per grant, or a refusal on demand."""

    def __init__(self, *, expires_in_s: float = 3600.0) -> None:
        self.grants: list[str] = []
        self.refuse = False
        self.expires_in_s = expires_in_s

    async def password_grant(self, credentials: probe.Credentials) -> probe.Token:
        self.grants.append(credentials.email)
        if self.refuse:
            raise probe.SignInRefusedError("sign-in refused: HTTP 400 invalid_credentials")
        return probe.Token(f"token-{len(self.grants)}", time.monotonic() + self.expires_in_s)


async def until(condition: Callable[[], bool], within_s: float = 2.0) -> None:
    async with asyncio.timeout(within_s):
        while not condition():
            await asyncio.sleep(0.01)


async def pump(fake: FakePhoenix, sent_ago_ms: int = 40) -> None:
    """Broadcasts a sample every 20 ms, each stamped as sent `sent_ago_ms` ago."""
    while True:
        payload = {
            "type": "broadcast",
            "event": EVENT,
            "payload": {"sent_at_ms": probe.wall_ms() - sent_ago_ms, "stack": "lab"},
        }
        await fake.push(CHANNEL, "broadcast", payload)
        await asyncio.sleep(0.02)


@asynccontextmanager
async def serving(
    answer: Callable[[web.Request], Awaitable[web.Response]],
) -> AsyncIterator[str]:
    application = web.Application()
    application.router.add_post("/auth/v1/token", answer)
    runner = web.AppRunner(application)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


def telemetry_frame(event: str, payload: dict[str, object], *, topic: str = CHANNEL) -> Frame:
    return Frame(topic=topic, event="broadcast", payload={"event": event, "payload": payload})


# --- the arithmetic the verdict rests on ---------------------------------------------


def test_percentiles_are_nearest_rank_over_the_samples() -> None:
    summary = probe.summarize(evidence(latencies_ms=tuple(range(1, 101))))
    assert (summary.samples, summary.p50_ms, summary.p95_ms, summary.p99_ms, summary.max_ms) == (
        100,
        50,
        95,
        99,
        100,
    )


def test_a_run_without_samples_has_no_percentiles_and_no_check() -> None:
    summary = probe.summarize(evidence())
    assert (summary.samples, summary.p95_ms, summary.max_ms) == (0, None, None)
    assert summary.outsider_refused is None


def test_reconnects_are_the_joins_after_the_first() -> None:
    assert probe.summarize(evidence(joins=3)).reconnects == 2
    assert probe.summarize(evidence(joins=1)).reconnects == 0
    assert probe.summarize(evidence(joins=0)).reconnects == 0


def test_the_outsider_is_refused_only_when_every_check_is_refused() -> None:
    refused = probe.Verdict(refused=True)
    assert probe.combined_refusal([refused, refused]) is True
    assert probe.combined_refusal([refused, probe.Verdict(refused=False)]) is False
    assert probe.combined_refusal([refused, probe.Verdict(refused=None)]) is None
    assert probe.summarize(evidence(verdicts=(refused,))).outsider_refused is True


def test_the_longest_silence_counts_the_start_the_end_and_every_gap() -> None:
    assert probe.longest_gap_ms(0.0, 10.0, [1.0, 1.5, 9.0]) == 7500
    assert probe.longest_gap_ms(0.0, 10.0, [4.0, 4.5]) == 5500
    assert probe.longest_gap_ms(0.0, 10.0, []) == 10000


def test_a_sample_is_read_on_its_own_topic_and_event_and_whole_when_sent() -> None:
    assert probe.sent_at_ms_of(telemetry_frame(EVENT, {"sent_at_ms": 7}), TOPIC) == 7
    assert (
        probe.sent_at_ms_of(telemetry_frame(EVENT, {"sent_at_ms": 7}, topic="realtime:x"), TOPIC)
        is None
    )
    assert probe.sent_at_ms_of(telemetry_frame("state", {"sent_at_ms": 7}), TOPIC) is None
    heartbeat = Frame(topic="phoenix", event="phx_reply", payload={"status": "ok"}, ref="2")
    assert probe.sent_at_ms_of(heartbeat, TOPIC) is None


@pytest.mark.parametrize("sent_at_ms", [None, True, -1, 1.5, "7"])
def test_a_sample_without_a_whole_non_negative_sent_at_ms_is_malformed(sent_at_ms: object) -> None:
    with pytest.raises(probe.MalformedSampleError):
        probe.sent_at_ms_of(telemetry_frame(EVENT, {"sent_at_ms": sent_at_ms}), TOPIC)


def test_a_frame_decodes_as_realtime_sends_it() -> None:
    text = (
        '{"topic": "realtime:' + TOPIC + '", "event": "broadcast", "ref": null,'
        ' "payload": {"type": "broadcast", "event": "sample",'
        ' "payload": {"sent_at_ms": 1790800000500, "stack": "lab"}}}'
    )
    assert probe.sent_at_ms_of(decode(text), TOPIC) == 1790800000500


def test_the_recorder_counts_joins_and_drops_and_freezes_at_the_end_of_the_run() -> None:
    recorder = probe.Recorder()
    recorder.joined()
    recorder.sample(sent_at_ms=10, read_at_ms=15, read_at_s=1.0)
    recorder.dropped()
    recorder.joined()
    recorder.sample(sent_at_ms=20, read_at_ms=30, read_at_s=2.0)
    recorder.stop()
    recorder.dropped()
    recorder.sample(sent_at_ms=30, read_at_ms=99, read_at_s=3.0)
    assert (recorder.joins, recorder.drops, recorder.up) == (2, 1, True)
    assert recorder.latencies_ms == [5, 10]
    assert recorder.samples_since_join == 1


def test_the_failures_are_the_pass_condition_and_the_stream_checks() -> None:
    passing = evidence(latencies_ms=tuple(range(1, 101)), verdicts=(probe.Verdict(refused=True),))
    assert probe.failures(passing, max_p95_ms=150) == []
    assert probe.failures(evidence(latencies_ms=(151,) * 20), max_p95_ms=150) == [
        "p95 is 151 ms, above 150 ms"
    ]
    assert probe.failures(evidence(latencies_ms=(150,) * 20), max_p95_ms=150) == []


def test_a_run_with_no_sample_fails_with_the_reason_realtime_gave() -> None:
    found = probe.failures(evidence(last_error="JoinRefusedError: Unauthorized"), 150)
    assert found == ["no sample reached the member in 600 s: JoinRefusedError: Unauthorized"]


def test_an_outsider_that_joined_fails_and_one_that_was_not_checked_to_an_answer_fails() -> None:
    joined = probe.failures(
        evidence(latencies_ms=(10,), verdicts=(probe.Verdict(refused=False),)), 150
    )
    assert joined == ["the outsider joined the topic: its join was not refused"]
    unanswered = probe.failures(
        evidence(
            latencies_ms=(10,),
            verdicts=(probe.Verdict(refused=None, detail="no answer within 30 s"),),
        ),
        150,
    )
    assert unanswered == ["the outsider check did not complete: no answer within 30 s"]


def test_a_stream_lost_after_its_drop_and_never_rejoined_fails() -> None:
    found = probe.failures(evidence(latencies_ms=(10,), joins=1, drops=1, up_at_end=False), 150)
    assert found == ["the member's socket did not rejoin after its last drop"]


def test_a_rejoined_stream_that_delivers_nothing_fails() -> None:
    found = probe.failures(
        evidence(latencies_ms=(10,), joins=2, drops=1, samples_since_join=0), 150
    )
    assert found == ["no sample reached the member after its last rejoin"]


def test_a_rejoined_stream_that_delivers_passes() -> None:
    passing = evidence(latencies_ms=(10, 12), joins=2, drops=1, samples_since_join=2)
    assert probe.failures(passing, 150) == []


def test_malformed_samples_and_negative_latencies_fail_the_run() -> None:
    assert probe.failures(evidence(latencies_ms=(10,), malformed=2), 150) == [
        "2 telemetry sample(s) without a whole sent_at_ms"
    ]
    assert probe.failures(evidence(latencies_ms=(-3,)), 150) == [
        "a sample was read before its sent_at_ms: the clocks disagree"
    ]


def test_a_member_stream_that_stopped_fails_with_its_error() -> None:
    found = probe.failures(evidence(latencies_ms=(10,), fatal="SignInRefusedError: refused"), 150)
    assert found == ["the member's stream stopped: SignInRefusedError: refused"]


def test_redact_replaces_every_secret_and_skips_the_empty_ones() -> None:
    text = f"key={ANON} for {MEMBER.email} and ''"
    redacted = probe.redact(text, [ANON, MEMBER.email, ""])
    assert redacted == "key=*** for *** and ''"
    assert ANON not in redacted and MEMBER.email not in redacted


def test_a_token_is_signed_in_again_within_a_minute_of_its_expiry() -> None:
    token = probe.Token("value", expires_at_s=1000.0)
    assert probe.renewal_due(token, now_s=939.0) is False
    assert probe.renewal_due(token, now_s=941.0) is True


def test_a_token_never_shows_in_its_repr() -> None:
    assert "value" not in repr(probe.Token("secret-value", expires_at_s=1.0))
    assert MEMBER.password not in repr(MEMBER)
    assert MEMBER.email not in repr(MEMBER)


# --- the command line and the environment --------------------------------------------


def test_the_arguments_default_to_ten_minutes_and_150_ms() -> None:
    arguments = probe.parse_arguments(
        ["--supabase-url", "http://kong:8000/", "--organization", str(ORGANIZATION)]
    )
    assert (arguments.seconds, arguments.max_p95_ms) == (600, 150)
    assert arguments.supabase_url == "http://kong:8000"
    assert arguments.organization == ORGANIZATION


@pytest.mark.parametrize(
    "extra",
    [
        ["--supabase-url", "kong:8000", "--organization", str(ORGANIZATION)],
        ["--supabase-url", "http://kong:8000", "--organization", "not-a-uuid"],
        [
            "--supabase-url",
            "http://kong:8000",
            "--organization",
            str(ORGANIZATION),
            "--seconds",
            "0",
        ],
        [
            "--supabase-url",
            "http://kong:8000",
            "--organization",
            str(ORGANIZATION),
            "--password",
            "x",
        ],
    ],
)
def test_the_arguments_refuse_bad_values_and_any_secret_as_an_argument(extra: list[str]) -> None:
    with pytest.raises(SystemExit):
        probe.parse_arguments(extra)


def environment(**overrides: str) -> dict[str, str]:
    values = {
        "SOC_PROBE_ANON_KEY": ANON,
        "SOC_PROBE_EMAIL": MEMBER.email,
        "SOC_PROBE_PASSWORD": MEMBER.password,
    }
    return {**values, **overrides}


PLATFORM_ARGUMENTS = ["--supabase-url", "http://kong:8000", "--organization", str(ORGANIZATION)]


def test_the_secrets_come_from_the_environment_and_a_missing_one_is_named_not_shown() -> None:
    config = probe.configuration(probe.parse_arguments(PLATFORM_ARGUMENTS), environment())
    assert config.member == MEMBER
    assert config.outsider is None
    with pytest.raises(probe.ConfigurationError) as refusal:
        probe.configuration(
            probe.parse_arguments(PLATFORM_ARGUMENTS),
            {"SOC_PROBE_ANON_KEY": ANON, "SOC_PROBE_EMAIL": MEMBER.email},
        )
    assert "SOC_PROBE_PASSWORD" in str(refusal.value)
    assert MEMBER.email not in str(refusal.value)


def test_the_outsider_needs_both_its_email_and_its_password() -> None:
    parsed = probe.parse_arguments(PLATFORM_ARGUMENTS)
    with pytest.raises(probe.ConfigurationError, match="both"):
        probe.configuration(parsed, environment(SOC_PROBE_OUTSIDER_EMAIL=STRANGER.email))
    config = probe.configuration(
        parsed,
        environment(
            SOC_PROBE_OUTSIDER_EMAIL=STRANGER.email,
            SOC_PROBE_OUTSIDER_PASSWORD=STRANGER.password,
        ),
    )
    assert config.outsider == STRANGER
    every_secret = {ANON, MEMBER.email, MEMBER.password, STRANGER.email, STRANGER.password}
    assert set(config.secrets()) == every_secret


def test_a_configuration_shows_no_secret_in_its_repr() -> None:
    text = repr(probe.configuration(probe.parse_arguments(PLATFORM_ARGUMENTS), environment()))
    assert ANON not in text and MEMBER.email not in text and MEMBER.password not in text


def test_main_refuses_a_run_with_a_missing_secret_on_stderr(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # --seconds 1: were the refusal lost, the run must end in a second, not in ten minutes.
    code = probe.main(
        [
            "--supabase-url",
            "http://kong:8000",
            "--organization",
            str(ORGANIZATION),
            "--seconds",
            "1",
        ],
        environ={"SOC_PROBE_ANON_KEY": ANON, "SOC_PROBE_EMAIL": MEMBER.email},
    )
    captured = capsys.readouterr()
    assert code == 2
    assert "SOC_PROBE_PASSWORD" in captured.err
    assert MEMBER.email not in captured.err
    assert captured.out == ""


# --- GoTrue's password grant, against a local server ----------------------------------


async def test_the_password_grant_posts_the_credentials_with_the_anon_key() -> None:
    seen: list[tuple[dict[str, str], str | None, dict[str, Any]]] = []

    async def answer(request: web.Request) -> web.Response:
        body: dict[str, Any] = await request.json()
        seen.append((dict(request.query), request.headers.get("apikey"), body))
        return web.json_response({"access_token": "signed", "expires_in": 3600})

    async with serving(answer) as base, aiohttp.ClientSession() as http:
        token = await probe.GoTrue(http, base, ANON).password_grant(MEMBER)
    assert token.value == "signed"
    assert seen == [
        ({"grant_type": "password"}, ANON, {"email": MEMBER.email, "password": MEMBER.password})
    ]
    assert 3500 < token.expires_at_s - time.monotonic() <= 3600


async def test_a_refused_password_grant_names_the_code_and_no_credential() -> None:
    async def refuse(_request: web.Request) -> web.Response:
        return web.json_response(
            {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"},
            status=400,
        )

    async with serving(refuse) as base, aiohttp.ClientSession() as http:
        with pytest.raises(probe.SignInRefusedError) as refusal:
            await probe.GoTrue(http, base, ANON).password_grant(MEMBER)
    assert str(refusal.value) == "sign-in refused: HTTP 400 invalid_credentials"


async def test_the_member_token_is_signed_in_again_when_it_nears_its_expiry() -> None:
    signin = FakeSignIn(expires_in_s=30)
    session = probe.Session(signin, MEMBER)
    await session.access_token()
    await session.access_token()
    assert len(signin.grants) == 2


# --- the socket, against Realtime's fake --------------------------------------------


async def test_the_member_joins_privately_with_its_token_and_times_each_sample() -> None:
    signin = FakeSignIn()
    async with FakePhoenix().serving() as fake:
        run = asyncio.create_task(
            probe.measure(config_for(fake.port), signin=signin, backoff=fast_backoff())
        )
        await until(lambda: len(fake.joins) == 1)
        broadcasting = asyncio.create_task(pump(fake))
        result = await run
        broadcasting.cancel()
    assert fake.queries[0]["apikey"] == [ANON]
    assert fake.queries[0]["vsn"] == ["1.0.0"]
    join = fake.joins[0]
    assert join["topic"] == CHANNEL
    assert join["payload"]["access_token"] == "token-1"
    assert join["payload"]["config"]["private"] is True
    assert signin.grants == [MEMBER.email]
    assert result.latencies_ms
    assert all(40 <= latency < 2000 for latency in result.latencies_ms)
    assert (result.joins, result.drops, result.malformed) == (1, 0, 0)


async def test_a_dropped_socket_is_joined_again_and_counted() -> None:
    async with FakePhoenix().serving() as fake:
        run = asyncio.create_task(
            probe.measure(
                config_for(fake.port, window_s=1.2), signin=FakeSignIn(), backoff=fast_backoff()
            )
        )
        await until(lambda: len(fake.joins) == 1)
        await fake.connections[-1].close()
        await until(lambda: len(fake.joins) == 2)
        broadcasting = asyncio.create_task(pump(fake))
        result = await run
        broadcasting.cancel()
    assert (result.joins, result.drops, result.up_at_end) == (2, 1, True)
    assert probe.summarize(result).reconnects == 1
    assert result.samples_since_join >= 1
    assert probe.failures(result, max_p95_ms=10_000) == []


async def test_a_socket_that_answers_no_heartbeat_is_replaced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(probe, "HEARTBEAT_S", 0.02)
    monkeypatch.setattr(probe, "REPLY_TIMEOUT_S", 0.1)
    async with FakePhoenix().serving() as fake:
        fake.answer_heartbeats = False
        result = await probe.measure(
            config_for(fake.port, window_s=1.0), signin=FakeSignIn(), backoff=fast_backoff()
        )
    assert fake.heartbeats >= 1
    assert result.drops >= 1
    assert result.joins >= 2


async def test_a_refused_join_is_reported_with_the_reason_realtime_gave() -> None:
    async with FakePhoenix().serving() as fake:
        fake.refused_topics.add(CHANNEL)
        result = await probe.measure(
            config_for(fake.port, window_s=0.5), signin=FakeSignIn(), backoff=fast_backoff()
        )
    assert result.latencies_ms == ()
    assert result.last_error is not None
    assert "Unauthorized" in result.last_error
    assert any("Unauthorized" in found for found in probe.failures(result, 150))


async def test_a_member_whose_sign_in_is_refused_ends_the_run_at_once() -> None:
    signin = FakeSignIn()
    signin.refuse = True
    async with FakePhoenix().serving() as fake:
        started = time.monotonic()
        result = await probe.measure(
            config_for(fake.port, window_s=3), signin=signin, backoff=fast_backoff()
        )
        elapsed = time.monotonic() - started
    assert result.fatal is not None
    assert "SignInRefusedError" in result.fatal
    assert elapsed < 5
    assert fake.joins == []


async def test_an_outsider_whose_join_realtime_refuses_is_refused() -> None:
    async with FakePhoenix().serving() as fake:
        fake.refused_topics.add(CHANNEL)
        verdict = await outsider_for(fake.port).check()
    assert verdict == probe.Verdict(refused=True)


async def test_an_outsider_whose_join_goes_through_is_not_refused() -> None:
    async with FakePhoenix().serving() as fake:
        verdict = await outsider_for(fake.port).check()
    assert verdict.refused is False


async def test_an_outsider_that_cannot_sign_in_gives_no_verdict_and_is_not_retried() -> None:
    signin = FakeSignIn()
    signin.refuse = True
    async with FakePhoenix().serving() as fake:
        verdict = await outsider_for(fake.port, signin).check()
    assert verdict.refused is None
    assert "SignInRefusedError" in verdict.detail
    assert signin.grants == [STRANGER.email]


async def test_a_run_with_an_outsider_checks_it_before_and_after_the_member_window() -> None:
    async with FakePhoenix().serving() as fake:
        fake.refused_topics.add(CHANNEL)
        result = await probe.measure(
            config_for(fake.port, window_s=0.2, outsider=True),
            signin=FakeSignIn(),
            backoff=fast_backoff(),
        )
    assert len(result.verdicts) == 2
    assert probe.summarize(result).outsider_refused is True
