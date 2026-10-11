"""Keep one link up: connect, serve until lost, back off, again (NFR-REL-03).

    supervisor = Supervisor(
        "database",
        connect=open_connection,          # returns the link, raises when refused
        serve=use_until_lost,             # returns or raises when the link is lost
        disconnect=close_connection,      # always called after serve
        transient=(OSError, TimeoutError),
    )
    await supervisor.run()

A transient error marks the link down and is retried after 0.5, 1, 2, 4, 8, then
every 10 s. The delay starts again from 0.5 s only after a link stayed up for
`stable_s`, so a link that is lost as soon as it is made, as one displaced by
another client is, backs off instead of hammering. Any other error ends `run()`:
a bug is not retried in a loop. `health` says whether the link is up, since
when, and the last error.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import soc_log

CAP_S = 10.0
STABLE_S = 10.0
NOT_YET = "not connected yet"
CLOSED_BY_PEER = "the other side closed the link"

log = soc_log.get(__name__)


@dataclass
class Backoff:
    initial_s: float = 0.5
    cap_s: float = CAP_S
    _next_s: float = field(init=False, default=0.0)

    def __post_init__(self) -> None:
        self.reset()

    def next(self) -> float:
        delay = self._next_s
        self._next_s = min(self.cap_s, delay * 2)
        return delay

    def reset(self) -> None:
        self._next_s = min(self.cap_s, self.initial_s)


@dataclass(frozen=True)
class Health:
    up: bool
    since: float
    error: str | None = None


def describe(error: BaseException) -> str:
    if isinstance(error, BaseExceptionGroup):
        return describe(error.exceptions[0])
    return f"{type(error).__name__}: {error}"


class Supervisor[Link]:
    def __init__(
        self,
        name: str,
        *,
        connect: Callable[[], Awaitable[Link]],
        serve: Callable[[Link], Awaitable[None]],
        disconnect: Callable[[Link], Awaitable[None]],
        transient: tuple[type[Exception], ...],
        backoff: Backoff | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        stable_s: float = STABLE_S,
    ) -> None:
        self.name = name
        self._connect = connect
        self._serve = serve
        self._disconnect = disconnect
        self._transient = transient
        self._backoff = backoff or Backoff()
        self._sleep = sleep
        self._stable_s = stable_s
        self._health = Health(up=False, since=time.monotonic(), error=NOT_YET)

    @property
    def health(self) -> Health:
        return self._health

    async def run(self) -> None:
        while True:
            try:
                link = await self._connect()
            except self._transient as error:
                self._mark_down(describe(error))
                await self._sleep(self._backoff.next())
                continue
            self._mark_up()
            up_since = self._health.since
            try:
                await self._serve(link)
                self._mark_down(CLOSED_BY_PEER)
            except* self._transient as lost:
                self._mark_down(describe(lost))
            finally:
                await self._disconnect(link)
            if time.monotonic() - up_since >= self._stable_s:
                self._backoff.reset()
            await self._sleep(self._backoff.next())

    def _mark_up(self) -> None:
        self._health = Health(up=True, since=time.monotonic())
        log.info("link_up", link=self.name)

    def _mark_down(self, detail: str) -> None:
        if self._health.up or self._health.error != detail:
            log.warning("link_down", link=self.name, error=detail)
        self._health = Health(up=False, since=time.monotonic(), error=detail)
