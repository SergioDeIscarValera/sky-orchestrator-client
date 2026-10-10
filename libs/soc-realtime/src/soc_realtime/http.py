from __future__ import annotations

from collections.abc import Sequence

import aiohttp
import msgspec

import soc_log
from soc_realtime.protocol import Endpoint, Message
from soc_supervision import describe

TIMEOUT_S = 5.0
DETAIL_CHARACTERS = 200

log = soc_log.get(__name__)


class HttpBroadcast:
    def __init__(
        self, endpoint: Endpoint, session: aiohttp.ClientSession, timeout_s: float = TIMEOUT_S
    ) -> None:
        self._url = endpoint.broadcast_url()
        self._headers = {
            "apikey": endpoint.key,
            "Authorization": f"Bearer {endpoint.key}",
            "Content-Type": "application/json",
        }
        self._session = session
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def send(self, messages: Sequence[Message]) -> bool:
        body = msgspec.json.encode(
            {
                "messages": [
                    {
                        "topic": message.topic,
                        "event": message.event,
                        "payload": dict(message.payload),
                        "private": True,
                    }
                    for message in messages
                ]
            }
        )
        try:
            async with self._session.post(
                self._url, data=body, headers=self._headers, timeout=self._timeout
            ) as response:
                if response.ok:
                    return True
                detail = (await response.text())[:DETAIL_CHARACTERS]
                log.warning("broadcast_refused", status=response.status, detail=detail)
                return False
        except (aiohttp.ClientError, TimeoutError) as error:
            log.warning("broadcast_failed", error=describe(error))
            return False
