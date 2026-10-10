from __future__ import annotations

import asyncio
import os
import signal
import threading

from soc_supervision.process import run


def test_a_stop_signal_ends_the_service_cleanly() -> None:
    cleaned_up = threading.Event()

    async def service() -> None:
        try:
            asyncio.get_running_loop().call_later(0.01, os.kill, os.getpid(), signal.SIGTERM)
            await asyncio.Event().wait()
        finally:
            cleaned_up.set()

    assert run(service) == 0
    assert cleaned_up.is_set()


def test_a_service_that_returns_ends_with_zero() -> None:
    async def service() -> None:
        await asyncio.sleep(0)

    assert run(service) == 0


def test_a_failing_service_ends_with_one() -> None:
    async def service() -> None:
        raise RuntimeError("a bug")

    assert run(service) == 1
