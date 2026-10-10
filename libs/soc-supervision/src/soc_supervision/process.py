from __future__ import annotations

import asyncio
import signal
from collections.abc import Callable, Coroutine
from typing import Any

import soc_log

STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)

log = soc_log.get(__name__)


def run(main: Callable[[], Coroutine[Any, Any, None]]) -> int:
    async def until_stopped() -> int:
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(soc_log.asyncio_exception_handler)
        task = asyncio.current_task()
        assert task is not None
        for stop in STOP_SIGNALS:
            loop.add_signal_handler(stop, task.cancel)
        try:
            await main()
        except asyncio.CancelledError:
            log.info("service_stopped")
            return 0
        except Exception:
            log.exception("service_failed")
            return 1
        return 0

    return asyncio.run(until_stopped())
