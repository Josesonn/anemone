"""Pre-started idle containers so a task starts in well under a second. Each one serves exactly one task."""
from __future__ import annotations

import threading
import time

from .config import Config
from .optimizer import Resources
from .sandbox import create_container, destroy

IDLE = Resources(0.25, 0.25)


class WarmPool:
    def __init__(self, client, cfg: Config, owner: str):
        self.client, self.cfg, self.owner = client, cfg, owner
        self.idle: dict[tuple[str, str], list] = {}
        self.target = 1
        self._lock = threading.Lock()
        self.closed = False
        self.keys: dict[tuple[str, str], float] = {(cfg.image, cfg.network): float("inf")}

    def take(self, image: str, network: str):
        key = (image, network)
        with self._lock:
            self.keys[key] = max(self.keys.get(key, 0), time.time())
            while self.idle.get(key):
                c = self.idle[key].pop()
                try:
                    c.reload()
                    if c.status == "running":
                        return c
                except Exception:
                    pass
                destroy(c)
        return None

    def size(self) -> int:
        with self._lock:
            return sum(len(v) for v in self.idle.values())

    def refill(self) -> None:
        """Blocking. Tops each recently used image/network pair up to the target and trims extras."""
        now = time.time()
        with self._lock:
            keys = [k for k, t in self.keys.items() if now - t < 600]
            extras = []
            for k, lst in self.idle.items():
                while len(lst) > self.target:
                    extras.append(lst.pop())
        for c in extras:
            destroy(c)
        for key in keys:
            while True:
                with self._lock:
                    if self.closed or len(self.idle.setdefault(key, [])) >= self.target:
                        break
                try:
                    c = create_container(self.client, self.cfg, key[0], key[1], IDLE, self.owner)
                except Exception:
                    break
                with self._lock:
                    if not self.closed:
                        self.idle[key].append(c)
                        continue
                destroy(c)  # closed while it was being created
                break

    def drain(self) -> None:
        with self._lock:
            self.closed = True
            all_c = [c for lst in self.idle.values() for c in lst]
            self.idle.clear()
        for c in all_c:
            destroy(c)
