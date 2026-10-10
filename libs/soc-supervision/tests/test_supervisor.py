from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

from soc_supervision import CAP_S, CLOSED_BY_PEER, NOT_YET, Backoff, Supervisor, describe


class Link:
    def __init__(self, number: int) -> None:
        self.number = number
        self.lost = asyncio.Event()
        self.failure: BaseException | None = None


class Peer:
    def __init__(self, *refusals: Exception) -> None:
        self.refusals = list(refusals)
        self.refusing: Exception | None = None
        self.links: list[Link] = []
        self.disconnected: list[int] = []
        self.down_when_disconnected: list[str | None] = []
        self.sleeps: list[float] = []
        self.watched: Supervisor[Link] | None = None

    async def connect(self) -> Link:
        if self.refusals:
            raise self.refusals.pop(0)
        if self.refusing is not None:
            raise self.refusing
        link = Link(len(self.links) + 1)
        self.links.append(link)
        return link

    async def serve(self, link: Link) -> None:
        await link.lost.wait()
        if link.failure is not None:
            raise link.failure

    async def disconnect(self, link: Link) -> None:
        self.disconnected.append(link.number)
        if self.watched is not None:
            self.down_when_disconnected.append(self.watched.health.error)

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        await asyncio.sleep(0)

    def supervisor(self) -> Supervisor[Link]:
        self.watched = Supervisor(
            "probe",
            connect=self.connect,
            serve=self.serve,
            disconnect=self.disconnect,
            transient=(OSError, TimeoutError),
            sleep=self.sleep,
        )
        return self.watched


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(1):
        while not condition():
            await asyncio.sleep(0.001)


def test_the_backoff_doubles_up_to_ten_seconds_and_resets() -> None:
    backoff = Backoff()
    assert [backoff.next() for _ in range(7)] == [0.5, 1, 2, 4, 8, CAP_S, CAP_S]
    backoff.reset()
    assert backoff.next() == 0.5


def test_a_group_is_described_by_its_first_error() -> None:
    group = ExceptionGroup("lost", [ConnectionResetError("reset by peer"), TimeoutError()])
    assert describe(group) == "ConnectionResetError: reset by peer"


async def test_refusals_are_retried_with_backoff_until_it_connects() -> None:
    peer = Peer(OSError("refused"), TimeoutError("slow"))
    supervisor = peer.supervisor()
    assert supervisor.health.error == NOT_YET
    task = asyncio.create_task(supervisor.run())
    await until(lambda: supervisor.health.up)
    task.cancel()
    assert peer.sleeps == [0.5, 1.0]


async def test_health_names_the_last_refusal() -> None:
    peer = Peer()
    peer.refusing = OSError("connection refused")
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.sleeps) >= 2)
    assert not supervisor.health.up
    assert supervisor.health.error == "OSError: connection refused"
    task.cancel()


async def test_a_lost_link_is_disconnected_and_replaced_with_the_delay_reset() -> None:
    peer = Peer(OSError("refused"))
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    peer.links[0].failure = ConnectionResetError("reset")
    peer.links[0].lost.set()
    await until(lambda: len(peer.links) == 2)
    task.cancel()
    assert peer.disconnected == [1]
    assert peer.sleeps == [0.5, 0.5]


async def test_a_link_closed_by_the_peer_is_replaced() -> None:
    peer = Peer()
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    peer.links[0].lost.set()
    await until(lambda: len(peer.links) == 2)
    task.cancel()
    assert peer.down_when_disconnected == [CLOSED_BY_PEER]


async def test_transient_errors_inside_a_group_are_a_lost_link() -> None:
    peer = Peer()
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    peer.links[0].failure = ExceptionGroup("reader", [OSError("broken pipe")])
    peer.links[0].lost.set()
    await until(lambda: len(peer.links) == 2)
    task.cancel()
    assert peer.disconnected == [1]


async def test_a_bug_ends_the_run_after_disconnecting() -> None:
    peer = Peer()
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    peer.links[0].failure = ValueError("a bug")
    peer.links[0].lost.set()
    with pytest.raises(ValueError, match="a bug"):
        await task
    assert peer.disconnected == [1]


async def test_a_bug_inside_a_group_ends_the_run() -> None:
    peer = Peer()
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    peer.links[0].failure = ExceptionGroup("reader", [OSError("reset"), ValueError("a bug")])
    peer.links[0].lost.set()
    with pytest.raises(ExceptionGroup) as ended:
        await task
    assert ended.group_contains(ValueError)
    assert not ended.group_contains(OSError)


async def test_a_bug_while_connecting_ends_the_run() -> None:
    peer = Peer(KeyError("a bug"))
    with pytest.raises(KeyError):
        await asyncio.wait_for(peer.supervisor().run(), 1)


async def test_cancelling_disconnects_the_live_link() -> None:
    peer = Peer()
    supervisor = peer.supervisor()
    task = asyncio.create_task(supervisor.run())
    await until(lambda: len(peer.links) == 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert peer.disconnected == [1]
