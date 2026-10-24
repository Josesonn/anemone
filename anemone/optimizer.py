"""Pure sizing and tuning logic. No Docker calls, so it is easy to test against fake hardware."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .config import Config
from .hardware import HardwareSnapshot

MIN_CPUS = 0.25
MIN_MEM_GB = 0.25


@dataclass(frozen=True)
class Resources:
    cpus: float
    mem_gb: float

    def clamp(self, budget: "Budget") -> "Resources":
        return Resources(min(max(self.cpus, MIN_CPUS), budget.cpus), min(max(self.mem_gb, MIN_MEM_GB), budget.mem_gb))


@dataclass(frozen=True)
class Budget:
    cpus: float
    mem_gb: float


def compute_budget(hw: HardwareSnapshot, cfg: Config) -> Budget:
    """Everything Docker can use, minus a reserve that keeps the host responsive."""
    rc = max(cfg.reserve_cpu_min, hw.cpus * cfg.reserve_cpu_frac)
    rm = max(cfg.reserve_mem_min_gb, hw.mem_gb * cfg.reserve_mem_frac)
    return Budget(cpus=max(0.5, hw.cpus - rc), mem_gb=max(0.5, hw.mem_gb - rm))


def _round(x: float, step: float) -> float:
    return max(step, round(x / step) * step)


def size_classes(b: Budget) -> dict[str, Resources]:
    """small/medium/large scale with the machine instead of being hard-coded."""
    small = Resources(max(0.5, _round(b.cpus / 32, 0.25)), max(0.5, _round(b.mem_gb / 32, 0.25)))
    medium = Resources(min(b.cpus, small.cpus * 2), min(b.mem_gb, small.mem_gb * 2))
    large = Resources(min(b.cpus, small.cpus * 4), min(b.mem_gb, small.mem_gb * 4))
    return {"small": small, "medium": medium, "large": large}


def max_concurrency(b: Budget, per_task: Resources, cfg: Config) -> int:
    by_cpu = b.cpus * cfg.cpu_overcommit / per_task.cpus
    by_mem = b.mem_gb / per_task.mem_gb
    n = max(1, math.floor(min(by_cpu, by_mem)))
    return min(n, cfg.max_concurrency) if cfg.max_concurrency else n


def fits(req: Resources, used: Resources, b: Budget, cfg: Config) -> bool:
    return (used.cpus + req.cpus <= b.cpus * cfg.cpu_overcommit + 1e-9
            and used.mem_gb + req.mem_gb <= b.mem_gb + 1e-9)


class Tuner:
    """AIMD concurrency control: grow by one when there is slack and work waiting, cut 25% under pressure."""

    def __init__(self, ceiling: int):
        self.limit = max(1, ceiling)
        self.last_reason = "start"

    def update(self, ceiling: int, cpu_util: float, mem_util: float, oom_recent: bool, queued: int, running: int, cfg: Config) -> int:
        ceiling = max(1, ceiling)
        if oom_recent or cpu_util > cfg.cpu_high or mem_util > cfg.mem_high:
            self.limit = max(1, math.floor(self.limit * 0.75))
            self.last_reason = "oom" if oom_recent else "cpu pressure" if cpu_util > cfg.cpu_high else "memory pressure"
        elif queued > 0 and running >= self.limit and cpu_util < cfg.cpu_low and mem_util < cfg.mem_low:
            self.limit += 1
            self.last_reason = "slack, growing"
        else:
            self.last_reason = "steady"
        self.limit = min(self.limit, ceiling)
        return self.limit


def boosted_cpus(base: float, cpu_util: float, budget: Budget, running: int, cfg: Config) -> float:
    """Give running tasks spare cores while the host is idle; hand them back under load."""
    if cpu_util >= cfg.cpu_low or running == 0:
        return base
    share = budget.cpus / running
    return max(base, min(base * 4, share))


def learned_size(samples: list[tuple[float, float]], min_samples: int = 3) -> Resources | None:
    """p95 of observed peaks for this kind of task, plus 20% headroom."""
    if len(samples) < min_samples:
        return None

    def p95(xs: list[float]) -> float:
        xs = sorted(xs)
        return xs[min(len(xs) - 1, math.ceil(0.95 * len(xs)) - 1)]

    cpu = p95([s[0] for s in samples]) * 1.2
    mem = p95([s[1] for s in samples]) * 1.2
    return Resources(max(MIN_CPUS, _round(cpu, 0.25)), max(MIN_MEM_GB, _round(mem, 0.125)))
