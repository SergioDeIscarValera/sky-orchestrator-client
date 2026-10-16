"""Broadcast latency from soc-cloud to a member's browser, measured on the mini-PC (DEP-23).

`soc-broadcast-probe` runs in soc-cloud's image, beside soc-cloud, so both read one
clock: each `sample` on the organization's private telemetry topic is timed from the
`sent_at_ms` soc-cloud stamped when it broadcast it, to its arrival here (NFR-PERF-01).

The probe joins as the console does: a GoTrue password grant with the member's
credentials, Realtime's websocket through Kong with the anon key as `apikey`, the topic
joined as a private channel with the member's access token, a heartbeat every 5 s as
realtime-js sends. A dropped socket is joined again under backoff, and each drop, each
rejoin and the longest silence are counted. A non-member's join is tried before the run
and again after it, so a refusal that holds across a Realtime restart is seen.

Secrets come from the environment only, never from an argument, and no line the probe
writes carries one: not the anon key, an email, a password or a token.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import itertools
import json
import os
import re
import sys
import time
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from http import HTTPStatus
from typing import Any, Protocol

import aiohttp
import websockets
from websockets.asyncio.client import ClientConnection

import soc_log
from soc_cloud.fanout import EVENT, telemetry_topic
from soc_cloud.latency import nearest_rank
from soc_realtime.protocol import (
    BROADCAST,
    CHANNEL_FAILURES,
    PHOENIX,
    REPLY,
    TOPIC_PREFIX,
    Endpoint,
    Frame,
    decode,
    encode,
    heartbeat,
    join,
)
from soc_realtime.socket import Connector
from soc_supervision import Backoff, Supervisor, describe

SERVICE = "soc-broadcast-probe"
REALTIME_PATH = "/realtime/v1"
AUTH_PATH = "/auth/v1"
#: realtime-js beats every HEARTBEAT_MS in apps/soc-web/src/backend/link.ts.
HEARTBEAT_S = 5.0
#: A heartbeat or a join unanswered this long is a socket lost, as the console counts it.
REPLY_TIMEOUT_S = 10.0
CLOSE_TIMEOUT_S = 2.0
SIGN_IN_TIMEOUT_S = 10.0
#: The outsider's join is tried this long before the check is reported as not completed.
OUTSIDER_WITHIN_S = 30.0
#: The member's token is signed in again this long before it expires.
RENEW_BEFORE_S = 60.0
JOIN_REF = "1"
FIRST_HEARTBEAT_REF = 2
PASSED = 0
FAILED = 1
USAGE = 2
CODE = re.compile(r"[a-z_]{1,64}")


class ConfigurationError(Exception):
    """The arguments or the environment do not name a run."""


class SignInRefusedError(Exception):
    """GoTrue refused the password grant; the message names a status and a code only."""


class JoinRefusedError(Exception):
    """Realtime refused the member's join."""


class ChannelLostError(Exception):
    """Realtime closed or failed the telemetry channel while the socket stayed open."""


class MalformedSampleError(ValueError):
    """A sample on the telemetry topic without a whole, non-negative `sent_at_ms`."""


TRANSIENT: tuple[type[Exception], ...] = (
    OSError,
    TimeoutError,
    websockets.exceptions.WebSocketException,
    aiohttp.ClientError,
    JoinRefusedError,
    ChannelLostError,
)


@dataclass(frozen=True)
class Credentials:
    email: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True)
class Config:
    supabase_url: str
    anon_key: str = field(repr=False)
    organization: uuid.UUID
    window_s: float
    max_p95_ms: int
    member: Credentials
    outsider: Credentials | None = None

    def secrets(self) -> tuple[str, ...]:
        values = [self.anon_key, self.member.email, self.member.password]
        if self.outsider is not None:
            values += [self.outsider.email, self.outsider.password]
        return tuple(value for value in values if value)


@dataclass(frozen=True)
class Token:
    value: str = field(repr=False)
    expires_at_s: float


class SignIn(Protocol):
    async def password_grant(self, credentials: Credentials) -> Token: ...


class GoTrue:
    """GoTrue's password grant behind Kong, sent as supabase-js sends it."""

    def __init__(self, http: aiohttp.ClientSession, supabase_url: str, anon_key: str) -> None:
        self._http = http
        self._url = f"{supabase_url}{AUTH_PATH}/token"
        self._anon_key = anon_key

    async def password_grant(self, credentials: Credentials) -> Token:
        async with self._http.post(
            self._url,
            params={"grant_type": "password"},
            json={"email": credentials.email, "password": credentials.password},
            headers={"apikey": self._anon_key},
            timeout=aiohttp.ClientTimeout(total=SIGN_IN_TIMEOUT_S),
        ) as response:
            body = await _json_object(response)
            if response.status != HTTPStatus.OK:
                code = _code(body.get("error_code", body.get("error")))
                raise SignInRefusedError(f"sign-in refused: HTTP {response.status} {code}")
            access_token = body.get("access_token")
            expires_in = body.get("expires_in")
            if not isinstance(access_token, str) or not isinstance(expires_in, int):
                raise SignInRefusedError("sign-in answered no access token")
            return Token(access_token, time.monotonic() + expires_in)


async def _json_object(response: aiohttp.ClientResponse) -> dict[str, Any]:
    try:
        body: object = json.loads(await response.text())
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _code(value: object) -> str:
    if isinstance(value, str) and CODE.fullmatch(value):
        return value
    return "without a code"


class Session:
    """A member's access token, signed in again once it nears its expiry."""

    def __init__(self, signin: SignIn, credentials: Credentials) -> None:
        self._signin = signin
        self._credentials = credentials
        self._token: Token | None = None

    async def access_token(self) -> str:
        if self._token is None or renewal_due(self._token, time.monotonic()):
            self._token = await self._signin.password_grant(self._credentials)
        return self._token.value


def renewal_due(token: Token, now_s: float) -> bool:
    return token.expires_at_s - now_s <= RENEW_BEFORE_S


def wall_ms() -> int:
    return time.time_ns() // 1_000_000


async def join_topic(socket: ClientConnection, topic: str, access_token: str) -> Frame:
    """Joins `topic` as a private channel and returns Realtime's reply to the join."""
    await socket.send(encode(join(topic, JOIN_REF, access_token)))
    async with asyncio.timeout(REPLY_TIMEOUT_S):
        while True:
            frame = decode(await socket.recv())
            if frame.event == REPLY and frame.ref == JOIN_REF:
                return frame


def refused(reply: Frame) -> bool:
    return reply.payload.get("status") != "ok"


def reason(reply: Frame) -> str:
    response = reply.payload.get("response")
    if isinstance(response, dict) and "reason" in response:
        return str(response["reason"])
    return str(reply.payload.get("status", "no status"))


def sent_at_ms_of(frame: Frame, topic: str) -> int | None:
    """The `sent_at_ms` of a `sample` broadcast on `topic`; None for any other frame."""
    if frame.event != BROADCAST or frame.topic != TOPIC_PREFIX + topic:
        return None
    if frame.payload.get("event") != EVENT:
        return None
    body = frame.payload.get("payload")
    sent_at_ms = body.get("sent_at_ms") if isinstance(body, dict) else None
    if isinstance(sent_at_ms, bool) or not isinstance(sent_at_ms, int) or sent_at_ms < 0:
        raise MalformedSampleError(f"a sample on {topic} has no whole, non-negative sent_at_ms")
    return sent_at_ms


class Recorder:
    """What the member's socket did, on the run's clocks; frozen once the run has ended."""

    def __init__(self) -> None:
        self.latencies_ms: list[int] = []
        self.receipts_s: list[float] = []
        self.joins = 0
        self.drops = 0
        self.up = False
        self.samples_since_join = 0
        self.malformed = 0
        self._stopped = False

    def stop(self) -> None:
        self._stopped = True

    def joined(self) -> None:
        if not self._stopped:
            self.joins += 1
            self.up = True
            self.samples_since_join = 0

    def dropped(self) -> None:
        if not self._stopped and self.up:
            self.up = False
            self.drops += 1

    def sample(self, *, sent_at_ms: int, read_at_ms: int, read_at_s: float) -> None:
        if not self._stopped:
            self.latencies_ms.append(read_at_ms - sent_at_ms)
            self.receipts_s.append(read_at_s)
            self.samples_since_join += 1

    def malformed_sample(self) -> None:
        if not self._stopped:
            self.malformed += 1


@dataclass
class _Link:
    socket: ClientConnection
    unanswered_since_s: float | None = None


class Member:
    """The member's browser on the telemetry topic: joined, read, beaten, and joined again."""

    def __init__(
        self,
        *,
        endpoint: Endpoint,
        topic: str,
        session: Session,
        recorder: Recorder,
        connector: Connector,
    ) -> None:
        self._endpoint = endpoint
        self._topic = topic
        self._channel = TOPIC_PREFIX + topic
        self._session = session
        self._recorder = recorder
        self._connector = connector
        self._refs = itertools.count(FIRST_HEARTBEAT_REF)

    async def connect(self) -> _Link:
        access_token = await self._session.access_token()
        socket = await self._connector(
            self._endpoint.websocket_url(),
            open_timeout=REPLY_TIMEOUT_S,
            close_timeout=CLOSE_TIMEOUT_S,
            ping_interval=None,
        )
        try:
            reply = await join_topic(socket, self._topic, access_token)
            if refused(reply):
                raise JoinRefusedError(reason(reply))
        except BaseException:
            await socket.close()
            raise
        self._recorder.joined()
        return _Link(socket)

    async def serve(self, link: _Link) -> None:
        async with asyncio.TaskGroup() as group:
            beating = group.create_task(self._beat(link))
            try:
                await self._read(link)
            finally:
                beating.cancel()

    async def disconnect(self, link: _Link) -> None:
        self._recorder.dropped()
        await link.socket.close()

    async def _read(self, link: _Link) -> None:
        async for text in link.socket:
            frame = decode(text)
            if frame.event == REPLY and frame.topic == PHOENIX:
                link.unanswered_since_s = None
            elif frame.event in CHANNEL_FAILURES and frame.topic == self._channel:
                raise ChannelLostError(f"{self._topic} received {frame.event}")
            else:
                self._sample(frame)

    def _sample(self, frame: Frame) -> None:
        try:
            sent_at_ms = sent_at_ms_of(frame, self._topic)
        except MalformedSampleError:
            self._recorder.malformed_sample()
            return
        if sent_at_ms is not None:
            self._recorder.sample(
                sent_at_ms=sent_at_ms, read_at_ms=wall_ms(), read_at_s=time.monotonic()
            )

    async def _beat(self, link: _Link) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            now_s = time.monotonic()
            if link.unanswered_since_s is not None:
                if now_s - link.unanswered_since_s >= REPLY_TIMEOUT_S:
                    raise TimeoutError("no heartbeat reply")
            else:
                link.unanswered_since_s = now_s
            await link.socket.send(encode(heartbeat(str(next(self._refs)))))


@dataclass(frozen=True)
class Verdict:
    """Whether a non-member's join was refused; None when no answer came, with why."""

    refused: bool | None
    detail: str = ""


class Outsider:
    """A non-member's join, tried until Realtime answers or the attempts run out."""

    def __init__(
        self, *, endpoint: Endpoint, topic: str, session: Session, connector: Connector
    ) -> None:
        self._endpoint = endpoint
        self._topic = topic
        self._session = session
        self._connector = connector

    async def check(self) -> Verdict:
        backoff = Backoff()
        last = "no attempt completed"
        try:
            async with asyncio.timeout(OUTSIDER_WITHIN_S):
                while True:
                    try:
                        return Verdict(refused=await self._attempt())
                    except SignInRefusedError as error:
                        return Verdict(refused=None, detail=describe(error))
                    except TRANSIENT as error:
                        last = describe(error)
                    await asyncio.sleep(backoff.next())
        except TimeoutError:
            return Verdict(refused=None, detail=f"no answer within {OUTSIDER_WITHIN_S:g} s: {last}")

    async def _attempt(self) -> bool:
        access_token = await self._session.access_token()
        socket = await self._connector(
            self._endpoint.websocket_url(),
            open_timeout=REPLY_TIMEOUT_S,
            close_timeout=CLOSE_TIMEOUT_S,
            ping_interval=None,
        )
        try:
            return refused(await join_topic(socket, self._topic, access_token))
        finally:
            await socket.close()


@dataclass(frozen=True)
class Evidence:
    """Everything one run measured, before it is judged."""

    window_s: float
    latencies_ms: tuple[int, ...]
    longest_gap_ms: int
    joins: int
    drops: int
    up_at_end: bool
    samples_since_join: int
    malformed: int
    verdicts: tuple[Verdict, ...]
    fatal: str | None
    last_error: str | None


@dataclass(frozen=True)
class Summary:
    """The one JSON object the probe prints on stdout."""

    samples: int
    p50_ms: int | None
    p95_ms: int | None
    p99_ms: int | None
    max_ms: int | None
    reconnects: int
    longest_gap_ms: int
    outsider_refused: bool | None


def longest_gap_ms(start_s: float, end_s: float, receipts_s: Sequence[float]) -> int:
    """The longest silence in the window: from its start to the first sample, between two
    samples, and from the last sample to its end. Receipts are in order on the monotonic clock."""
    points = [start_s, *receipts_s, end_s]
    return round(max(later - earlier for earlier, later in itertools.pairwise(points)) * 1000)


def combined_refusal(verdicts: Iterable[Verdict]) -> bool | None:
    """Refused only if every check was refused; not refused if any join went through."""
    answers = [verdict.refused for verdict in verdicts]
    if any(answer is False for answer in answers):
        return False
    if any(answer is None for answer in answers):
        return None
    return True


def summarize(evidence: Evidence) -> Summary:
    ordered = sorted(float(latency) for latency in evidence.latencies_ms)
    return Summary(
        samples=len(ordered),
        p50_ms=_whole(ordered, 0.50),
        p95_ms=_whole(ordered, 0.95),
        p99_ms=_whole(ordered, 0.99),
        max_ms=int(ordered[-1]) if ordered else None,
        reconnects=max(0, evidence.joins - 1),
        longest_gap_ms=evidence.longest_gap_ms,
        outsider_refused=combined_refusal(evidence.verdicts) if evidence.verdicts else None,
    )


def _whole(ordered: list[float], fraction: float) -> int | None:
    return int(nearest_rank(ordered, fraction)) if ordered else None


def failures(evidence: Evidence, max_p95_ms: int) -> list[str]:
    """Why the run fails; empty when it passes (DEP-23's pass condition, and what it adds)."""
    summary = summarize(evidence)
    found: list[str] = []
    if summary.samples == 0:
        silent = f"no sample reached the member in {evidence.window_s:g} s"
        found.append(silent if evidence.last_error is None else f"{silent}: {evidence.last_error}")
    elif summary.p95_ms is not None and summary.p95_ms > max_p95_ms:
        found.append(f"p95 is {summary.p95_ms} ms, above {max_p95_ms} ms")
    if any(latency < 0 for latency in evidence.latencies_ms):
        found.append("a sample was read before its sent_at_ms: the clocks disagree")
    if evidence.malformed:
        found.append(f"{evidence.malformed} telemetry sample(s) without a whole sent_at_ms")
    if evidence.drops and not evidence.up_at_end:
        found.append("the member's socket did not rejoin after its last drop")
    elif evidence.drops and evidence.samples_since_join == 0:
        found.append("no sample reached the member after its last rejoin")
    if evidence.fatal is not None:
        found.append(f"the member's stream stopped: {evidence.fatal}")
    if evidence.verdicts:
        if summary.outsider_refused is None:
            unanswered = "; ".join(v.detail for v in evidence.verdicts if v.refused is None)
            found.append(f"the outsider check did not complete: {unanswered}")
        elif not summary.outsider_refused:
            found.append("the outsider joined the topic: its join was not refused")
    return found


def redact(text: str, secrets: Iterable[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


async def measure(
    config: Config,
    *,
    signin: SignIn,
    connector: Connector = websockets.connect,
    backoff: Backoff | None = None,
) -> Evidence:
    """Checks a non-member, joins the member for the window, checks the non-member again."""
    endpoint = Endpoint(f"{config.supabase_url}{REALTIME_PATH}", config.anon_key)
    topic = telemetry_topic(config.organization)
    verdicts: list[Verdict] = []
    if config.outsider is not None:
        verdicts.append(await _outsider(config, endpoint, topic, signin, connector).check())

    recorder = Recorder()
    member = Member(
        endpoint=endpoint,
        topic=topic,
        session=Session(signin, config.member),
        recorder=recorder,
        connector=connector,
    )
    supervisor = Supervisor(
        "broadcast",
        connect=member.connect,
        serve=member.serve,
        disconnect=member.disconnect,
        transient=TRANSIENT,
        backoff=backoff,
    )
    started_s = time.monotonic()
    stream = asyncio.create_task(supervisor.run())
    await asyncio.wait({stream}, timeout=config.window_s)
    ended_s = time.monotonic()
    recorder.stop()
    fatal: str | None = None
    last_error: str | None = None
    if stream.done():
        error = stream.exception()
        fatal = "the stream ended" if error is None else describe(error)
    else:
        last_error = None if supervisor.health.up else supervisor.health.error
        stream.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stream

    if config.outsider is not None:
        verdicts.append(await _outsider(config, endpoint, topic, signin, connector).check())
    return Evidence(
        window_s=config.window_s,
        latencies_ms=tuple(recorder.latencies_ms),
        longest_gap_ms=longest_gap_ms(started_s, ended_s, recorder.receipts_s),
        joins=recorder.joins,
        drops=recorder.drops,
        up_at_end=recorder.up,
        samples_since_join=recorder.samples_since_join,
        malformed=recorder.malformed,
        verdicts=tuple(verdicts),
        fatal=fatal,
        last_error=last_error,
    )


def _outsider(
    config: Config,
    endpoint: Endpoint,
    topic: str,
    signin: SignIn,
    connector: Connector,
) -> Outsider:
    assert config.outsider is not None
    return Outsider(
        endpoint=endpoint,
        topic=topic,
        session=Session(signin, config.outsider),
        connector=connector,
    )


def parse_arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=SERVICE,
        description=(
            "Measure Broadcast latency to a member on one organization's telemetry topic. "
            "Credentials come from the SOC_PROBE_* environment variables, never arguments."
        ),
    )
    parser.add_argument(
        "--supabase-url",
        required=True,
        type=_base_url,
        metavar="URL",
        help="the gateway as the console reaches it, for example http://kong:8000",
    )
    parser.add_argument(
        "--organization",
        required=True,
        type=_organization,
        metavar="UUID",
        help="the organization whose telemetry topic the member joins",
    )
    parser.add_argument(
        "--seconds",
        type=_positive_int,
        default=600,
        help="how long the member stays joined (default: 600)",
    )
    parser.add_argument(
        "--max-p95-ms",
        type=_positive_int,
        default=150,
        help="the p95 latency that passes, in milliseconds (default: 150)",
    )
    return parser.parse_args(argv)


def _base_url(value: str) -> str:
    base = value.rstrip("/")
    parts = base.split("://", 1)
    if len(parts) != 2 or parts[0] not in ("http", "https") or not parts[1]:
        raise argparse.ArgumentTypeError("expected an http or https URL")
    return base


def _organization(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise argparse.ArgumentTypeError("expected an organization's UUID") from None


def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("expected a whole number") from None
    if number < 1:
        raise argparse.ArgumentTypeError("expected a number of at least 1")
    return number


def configuration(arguments: argparse.Namespace, environ: Mapping[str, str]) -> Config:
    """The run the arguments and the SOC_PROBE_* environment variables name."""
    outsider_email = environ.get("SOC_PROBE_OUTSIDER_EMAIL", "")
    outsider_password = environ.get("SOC_PROBE_OUTSIDER_PASSWORD", "")
    if bool(outsider_email) != bool(outsider_password):
        raise ConfigurationError(
            "set both SOC_PROBE_OUTSIDER_EMAIL and SOC_PROBE_OUTSIDER_PASSWORD, or neither"
        )
    return Config(
        supabase_url=arguments.supabase_url,
        anon_key=_required(environ, "SOC_PROBE_ANON_KEY"),
        organization=arguments.organization,
        window_s=float(arguments.seconds),
        max_p95_ms=arguments.max_p95_ms,
        member=Credentials(
            _required(environ, "SOC_PROBE_EMAIL"), _required(environ, "SOC_PROBE_PASSWORD")
        ),
        outsider=Credentials(outsider_email, outsider_password) if outsider_email else None,
    )


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "")
    if not value:
        raise ConfigurationError(f"{name} is not set")
    return value


async def run(config: Config) -> Evidence:
    async with aiohttp.ClientSession() as http:
        return await measure(config, signin=GoTrue(http, config.supabase_url, config.anon_key))


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    arguments = parse_arguments(argv)
    try:
        config = configuration(arguments, os.environ if environ is None else environ)
    except ConfigurationError as error:
        print(f"{SERVICE}: {error}", file=sys.stderr)
        return USAGE
    # Logs go to stderr: stdout carries the one JSON summary and nothing else.
    soc_log.configure(SERVICE, stream=sys.stderr.buffer)
    log = soc_log.get(__name__)
    secrets = config.secrets()
    log.info(
        "probe_started",
        organization=str(config.organization),
        window_s=config.window_s,
        max_p95_ms=config.max_p95_ms,
        outsider_checked=config.outsider is not None,
    )
    try:
        evidence = asyncio.run(run(config))
    except KeyboardInterrupt:
        log.error("probe_interrupted")
        return FAILED
    except Exception as error:
        log.error("probe_failed", reason=redact(describe(error), secrets))
        return FAILED
    print(json.dumps(asdict(summarize(evidence))))
    reasons = failures(evidence, config.max_p95_ms)
    for reason_text in reasons:
        log.error("probe_failed", reason=redact(reason_text, secrets))
    return FAILED if reasons else PASSED


if __name__ == "__main__":
    sys.exit(main())
