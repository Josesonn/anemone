"""GPU accounting. Consumer GPUs cannot be hard-partitioned, so VRAM is tracked, not enforced."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from .hardware import GPUInfo


class GPURequest(BaseModel):
    count: int = 1
    vram_gb: float = 0.0
    policy: Literal["wait", "fail", "cpu_fallback"] = "wait"


class GPUAllocator:
    def __init__(self, gpus: tuple[GPUInfo, ...], enabled: bool):
        self.enabled = enabled and bool(gpus)
        self.total = {g.index: g.vram_total_gb for g in gpus}
        self.free = dict(self.total)
        self.users = {g.index: 0 for g in gpus}

    def possible(self, req: GPURequest) -> bool:
        """Could this ever be satisfied on this machine?"""
        if not self.enabled or req.count > len(self.total):
            return False
        return sorted(self.total.values(), reverse=True)[req.count - 1] >= req.vram_gb

    def try_alloc(self, req: GPURequest) -> list[int] | None:
        if not self.possible(req):
            return None
        ok = [i for i in self.free if self.free[i] >= req.vram_gb]
        if len(ok) < req.count:
            return None
        # most free VRAM first, then fewest tenants
        ok.sort(key=lambda i: (-self.free[i], self.users[i]))
        chosen = ok[:req.count]
        for i in chosen:
            self.free[i] -= req.vram_gb
            self.users[i] += 1
        return chosen

    def release(self, ids: list[int], vram_gb: float) -> None:
        for i in ids:
            self.free[i] = min(self.total[i], self.free[i] + vram_gb)
            self.users[i] = max(0, self.users[i] - 1)
