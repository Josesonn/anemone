"""Anemone: queue, admission control, the tuning loop and the background housekeeping."""
from __future__ import annotations

import asyncio
import heapq
import itertools
import json
import os
import statistics
import time
from collections import deque
from dataclasses import dataclass, field

from . import janitor
from .config import Config
from .gpu import GPUAllocator
from .hardware import probe_docker_gpu, read_gpus, snapshot
from .history import History
from .optimizer import Resources, Tuner, boosted_cpus, compute_budget, fits, learned_size, max_concurrency, size_classes
from .pool import WarmPool
from .sandbox import Result, Sampler, Task, create_container, destroy, owner_id, resize, run_in


@dataclass
class _Run:
    task: Task
    req: Resources
    gpu_ids: list[int]
    started: float = field(default_factory=time.time)
    cpus_now: float = 0.0
    container: object = None
    sampler: Sampler | None = None


class Anemone:
    def __init__(self, config: Config | None = None, client=None):
        self.cfg = config or Config.load()
        self.client = client
        self.owner = owner_id()
        self._heap: list = []
        self._seq = itertools.count()
        self._running: dict[str, _Run] = {}
        self._used = Resources(0.0, 0.0)
        self._wake: asyncio.Event | None = None
        self._oom_flag = False
        self._bg: list[asyncio.Task] = []
        self._images: set[str] = set()
        self._events: deque[dict] = deque(maxlen=60)
        self._status_written = 0.0
        self.completed = 0
        self.failed = 0

    # ---------- lifecycle ----------
    async def __aenter__(self) -> "Anemone":
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def start(self) -> None:
        import docker
        if self.client is None:
            self.client = docker.from_env(max_pool_size=64, timeout=120)
        await asyncio.to_thread(self.client.ping)
        self._wake = asyncio.Event()
        self.history = History(self.cfg.state_path / "history.db")
        await asyncio.to_thread(janitor.sweep, self.client, False, self.owner)
        await asyncio.to_thread(self._ensure_image, self.cfg.image)
        gpu_ok = False
        if read_gpus():
            gpu_ok = await asyncio.to_thread(probe_docker_gpu, self.client, self.cfg.image, self.cfg.state_path / "gpu_probe.json")
        self.hw = await asyncio.to_thread(snapshot, self.client, gpu_ok)
        self.gpu = GPUAllocator(self.hw.gpus, gpu_ok)
        self._retune()
        self.tuner = Tuner(self.ceiling)
        self.pool = WarmPool(self.client, self.cfg, self.owner)
        self.pool.target = self._pool_target(0.0, 0.0)
        self._bg = [asyncio.create_task(f()) for f in (self._dispatch_loop, self._tune_loop, self._janitor_loop, self._pool_loop)]
        self._write_status()

    async def close(self) -> None:
        for t in self._bg:
            t.cancel()
        await asyncio.gather(*self._bg, return_exceptions=True)
        while self._heap:
            _, _, task, fut = heapq.heappop(self._heap)
            if not fut.done():
                fut.set_result(Result(id=task.id, kind=task.kind, error="cancelled: Anemone closed"))
        for r in list(self._running.values()):
            if r.container is not None:
                await asyncio.to_thread(destroy, r.container)
        await asyncio.to_thread(self.pool.drain)
        self.history.close()
        try:
            (self.cfg.state_path / "status.json").unlink()
        except FileNotFoundError:
            pass

    # ---------- public API ----------
    def submit(self, task: Task) -> asyncio.Future:
        fut = asyncio.get_running_loop().create_future()
        heapq.heappush(self._heap, (-task.priority, next(self._seq), task, fut))
        self._wake.set()
        return fut

    async def run(self, task: Task) -> Result:
        return await self.submit(task)

    async def map(self, tasks: list[Task]) -> list[Result]:
        return list(await asyncio.gather(*(self.submit(t) for t in tasks)))

    def status(self) -> dict:
        b = self.budget
        return {
            "ts": time.time(),
            "owner": self.owner,
            "hardware": {"cpus": self.hw.cpus, "mem_gb": round(self.hw.mem_gb, 1), "host_cpu_util": round(self.hw.host_cpu_util, 2),
                         "host_mem_util": round(self.hw.host_mem_util, 2), "gpus": [g.name for g in self.hw.gpus], "docker_gpu": self.gpu.enabled},
            "budget": {"cpus": b.cpus, "mem_gb": round(b.mem_gb, 1)},
            "sizes": {k: {"cpus": v.cpus, "mem_gb": v.mem_gb} for k, v in self.sizes.items()},
            "limit": self.tuner.limit, "ceiling": self.ceiling, "reason": self.tuner.last_reason,
            "used": {"cpus": round(self._used.cpus, 2), "mem_gb": round(self._used.mem_gb, 2)},
            "queued": len(self._heap), "pool": self.pool.size(), "completed": self.completed, "failed": self.failed,
            "tune_interval": self.cfg.tune_interval, "events": list(self._events),
            "running": [{"id": r.task.id, "kind": r.task.kind, "cpus": round(r.cpus_now or r.req.cpus, 2), "mem_gb": r.req.mem_gb,
                         "cpu_now": round(r.sampler.cpu_now, 2) if r.sampler else 0, "mem_now_gb": round(r.sampler.mem_now_gb, 2) if r.sampler else 0,
                         "gpus": r.gpu_ids, "elapsed": round(time.time() - r.started, 1),
                         "container": getattr(r.container, "id", None), "image": r.task.image or (self.cfg.gpu_image if r.gpu_ids else self.cfg.web_image if r.task.browser else self.cfg.image),
                         "network": r.task.network or self.cfg.network, "timeout": r.task.timeout or self.cfg.default_timeout,
                         "started": r.started} for r in self._running.values()],
        }

    # ---------- sizing ----------
    def _retune(self) -> None:
        self.budget = compute_budget(self.hw, self.cfg)
        self.sizes = size_classes(self.budget)
        reqs = [r.req for r in self._running.values()]
        typical = Resources(statistics.median(r.cpus for r in reqs), statistics.median(r.mem_gb for r in reqs)) if reqs else self.sizes["small"]
        self.ceiling = max_concurrency(self.budget, typical, self.cfg)

    def _resolve(self, task: Task) -> Resources:
        if task.size and task.size not in self.sizes:
            raise ValueError(f"unknown size {task.size!r}; use one of {list(self.sizes)}")
        base = self.sizes[task.size or "small"]
        if task.cpus or task.mem_gb:
            r = Resources(task.cpus or base.cpus, task.mem_gb or base.mem_gb)
        elif task.size:
            r = base
        else:
            r = learned_size(self.history.samples(task.kind)) or base
            last = self.history.last(task.kind)
            if last and last[1]:  # the previous run of this kind ran out of memory: double it
                r = Resources(r.cpus, max(r.mem_gb, last[0] * 2))
        if task.browser:
            r = Resources(r.cpus, max(r.mem_gb, self.cfg.browser_min_mem_gb))
        return r.clamp(self.budget)

    def _pool_target(self, cpu_util: float, mem_util: float) -> int:
        if cpu_util > self.cfg.cpu_high or mem_util > self.cfg.mem_high:
            return 0
        return max(1, round(self.tuner.limit * self.cfg.pool_fraction))

    def _ensure_image(self, image: str) -> str:
        if image in self._images:
            return image
        import docker
        try:
            self.client.images.get(image)
        except docker.errors.ImageNotFound:
            if image.startswith("anemone/"):
                raise RuntimeError(f"image {image} is not built yet; run `anemone doctor --build`")
            self.client.images.pull(image)
        self._images.add(image)
        return image

    # ---------- scheduling ----------
    def _dispatch(self) -> None:
        waiting = []
        while self._heap:
            item = heapq.heappop(self._heap)
            _, _, task, fut = item
            if fut.done():
                continue
            if len(self._running) >= self.tuner.limit:
                waiting.append(item)
                break
            try:
                req = self._resolve(task)
            except ValueError as e:
                fut.set_result(Result(id=task.id, kind=task.kind, error=str(e)))
                continue
            gpu_ids: list[int] = []
            if task.gpu:
                if not self.gpu.possible(task.gpu):
                    if task.gpu.policy == "cpu_fallback":
                        task = task.model_copy(update={"gpu": None})
                    else:
                        why = "Docker cannot reach a GPU" if not self.gpu.enabled else "no GPU on this machine matches the request"
                        fut.set_result(Result(id=task.id, kind=task.kind, error=f"GPU unavailable: {why}"))
                        continue
                else:
                    ids = self.gpu.try_alloc(task.gpu)
                    if ids is None:
                        if task.gpu.policy == "fail":
                            fut.set_result(Result(id=task.id, kind=task.kind, error="GPU busy"))
                        elif task.gpu.policy == "cpu_fallback":
                            task = task.model_copy(update={"gpu": None})
                        else:
                            waiting.append(item)
                            continue
                    else:
                        gpu_ids = ids
                    if fut.done():
                        continue
            if not fits(req, self._used, self.budget, self.cfg):
                if gpu_ids:
                    self.gpu.release(gpu_ids, task.gpu.vram_gb)
                waiting.append(item)
                continue
            self._used = Resources(self._used.cpus + req.cpus, self._used.mem_gb + req.mem_gb)
            self._running[task.id] = _Run(task, req, gpu_ids, cpus_now=req.cpus)
            self._event("start", task, cpus=req.cpus, mem_gb=req.mem_gb, gpus=gpu_ids)
            asyncio.create_task(self._execute(task, req, gpu_ids, fut))
        for item in waiting:
            heapq.heappush(self._heap, item)

    async def _execute(self, task: Task, req: Resources, gpu_ids: list[int], fut: asyncio.Future) -> None:
        try:
            res = await asyncio.to_thread(self._run_blocking, task, req, gpu_ids)
        except Exception as e:
            res = Result(id=task.id, kind=task.kind, cpus=req.cpus, mem_gb=req.mem_gb, error=f"{type(e).__name__}: {e}")
        finally:
            self._running.pop(task.id, None)
            self._used = Resources(max(0.0, self._used.cpus - req.cpus), max(0.0, self._used.mem_gb - req.mem_gb))
            if gpu_ids:
                self.gpu.release(gpu_ids, task.gpu.vram_gb if task.gpu else 0)
            self._wake.set()
        if res.oom:
            self._oom_flag = True
        if res.exit_code is not None or res.oom:
            self.history.record(task.kind, res.cpu_peak, res.mem_peak_gb, req.mem_gb, res.duration, res.oom)
        if res.ok:
            self.completed += 1
        else:
            self.failed += 1
        status = "ok" if res.ok else "stopped" if res.stopped else "timed_out" if res.timed_out else "out_of_memory" if res.oom else "error" if res.error else "failed"
        self._event("finish", task, status=status, exit_code=res.exit_code, duration=round(res.duration, 2),
                    cpu_peak=round(res.cpu_peak, 2), mem_peak_gb=round(res.mem_peak_gb, 3))
        if not fut.done():
            fut.set_result(res)

    def _run_blocking(self, task: Task, req: Resources, gpu_ids: list[int]) -> Result:
        if gpu_ids:
            image = task.image or self.cfg.gpu_image
            try:
                self._ensure_image(image)
            except RuntimeError:
                image = self.cfg.image  # GPU image not built: the NVIDIA runtime still injects the driver and nvidia-smi
        else:
            image = task.image or (self.cfg.web_image if task.browser else self.cfg.image)
        self._ensure_image(image)
        network = task.network or self.cfg.network
        c = None if gpu_ids else self.pool.take(image, network)
        if c is None:
            c = create_container(self.client, self.cfg, image, network, req, self.owner, gpu_ids)
        else:
            resize(c, req)
        run = self._running.get(task.id)
        sampler = Sampler(c)
        sampler.start()
        if run:
            run.container, run.sampler = c, sampler
        try:
            return run_in(self.client, c, task, req, self.cfg, gpu_ids, sampler)
        finally:
            destroy(c)

    # ---------- background loops ----------
    async def _dispatch_loop(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            self._dispatch()

    async def _tune_loop(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.tune_interval)
            try:
                self.hw = await asyncio.to_thread(snapshot, self.client, self.gpu.enabled)
                self._retune()
                cpu = self.hw.host_cpu_util
                cont_mem = sum(r.sampler.mem_now_gb for r in self._running.values() if r.sampler)
                mem = max(self.hw.host_mem_util, cont_mem / self.hw.mem_gb if self.hw.mem_gb else 0)
                oom, self._oom_flag = self._oom_flag, False
                self.tuner.update(self.ceiling, cpu, mem, oom, len(self._heap), len(self._running), self.cfg)
                await asyncio.to_thread(self._apply_boost, cpu)
                self.pool.target = self._pool_target(cpu, mem)
                self._write_status()
            except Exception:
                pass
            self._wake.set()

    def _apply_boost(self, cpu_util: float) -> None:
        cpu_runs = [r for r in self._running.values() if r.container is not None and not r.gpu_ids]
        for r in cpu_runs:
            want = boosted_cpus(r.req.cpus, cpu_util, self.budget, len(self._running), self.cfg)
            if abs(want - r.cpus_now) > 0.01:
                try:
                    resize(r.container, Resources(want, r.req.mem_gb))
                    r.cpus_now = want
                except Exception:
                    pass

    async def _janitor_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await asyncio.to_thread(janitor.sweep, self.client, False, self.owner)
            except Exception:
                pass

    async def _pool_loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.pool.refill)
            except Exception:
                pass
            await asyncio.sleep(1.0)

    def _event(self, kind: str, task: Task, **data) -> None:
        """Record a task start/finish for monitors and publish it right away (at most every 0.2 s)."""
        self._events.append({"type": kind, "id": task.id, "kind": task.kind, "ts": time.time(), **data})
        if time.time() - self._status_written > 0.2:
            self._write_status()

    def _write_status(self) -> None:
        """Write status.json atomically, so a monitor never reads a half-written file."""
        try:
            path = self.cfg.state_path / "status.json"
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text(json.dumps(self.status()))
            os.replace(tmp, path)
            self._status_written = time.time()
        except Exception:
            pass
