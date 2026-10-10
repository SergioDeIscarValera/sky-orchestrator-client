from __future__ import annotations

from dataclasses import dataclass, field

CAP_S = 10.0


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
