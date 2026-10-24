"""What the machine has, and what Docker can actually use of it."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

GB = 1024 ** 3


@dataclass(frozen=True)
class GPUInfo:
    index: int
    name: str
    vram_total_gb: float
    vram_free_gb: float
    util: float  # 0..1


@dataclass(frozen=True)
class HardwareSnapshot:
    docker_cpus: float
    docker_mem_gb: float
    host_cpus: int
    host_mem_total_gb: float
    host_mem_avail_gb: float
    host_cpu_util: float  # 0..1
    gpus: tuple[GPUInfo, ...] = ()
    docker_gpu_ok: bool = False
    taken_at: float = field(default_factory=time.time)

    @property
    def cpus(self) -> float:
        """Usable CPUs: Docker's VM can never use more than the host has."""
        return min(self.docker_cpus, self.host_cpus) if self.docker_cpus else self.host_cpus

    @property
    def mem_gb(self) -> float:
        return min(self.docker_mem_gb, self.host_mem_total_gb) if self.docker_mem_gb else self.host_mem_total_gb

    @property
    def host_mem_util(self) -> float:
        return 1 - self.host_mem_avail_gb / self.host_mem_total_gb if self.host_mem_total_gb else 0.0


def read_gpus() -> tuple[GPUInfo, ...]:
    try:
        import pynvml
        pynvml.nvmlInit()
    except Exception:
        return ()
    out = []
    try:
        for i in range(pynvml.nvmlDeviceGetCount()):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(h)
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            util = pynvml.nvmlDeviceGetUtilizationRates(h).gpu / 100
            out.append(GPUInfo(i, name.decode() if isinstance(name, bytes) else name, mem.total / GB, mem.free / GB, util))
    except Exception:
        pass
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    return tuple(out)


def probe_docker_gpu(client, image: str, cache: Path, max_age: float = 86400) -> bool:
    """Run nvidia-smi in a throwaway container once a day to see whether Docker can reach the GPU."""
    try:
        data = json.loads(cache.read_text())
        if time.time() - data["at"] < max_age:
            return bool(data["ok"])
    except Exception:
        pass
    ok = False
    try:
        from docker.types import DeviceRequest
        c = client.containers.run(
            image, ["nvidia-smi", "-L"], detach=True,
            device_requests=[DeviceRequest(count=-1, capabilities=[["gpu"]])],
            labels={"anemone.managed": "true", "anemone.owner": "probe", "anemone.expires": str(time.time() + 120)},
        )
        try:
            c.wait(timeout=60)
            ok = b"GPU" in (c.logs() or b"")
        finally:
            c.remove(force=True)
    except Exception:
        ok = False
    cache.write_text(json.dumps({"ok": ok, "at": time.time()}))
    return ok


def snapshot(client=None, docker_gpu_ok: bool = False) -> HardwareSnapshot:
    docker_cpus = docker_mem = 0.0
    if client is not None:
        try:
            info = client.info()
            docker_cpus = float(info.get("NCPU", 0))
            docker_mem = info.get("MemTotal", 0) / GB
        except Exception:
            pass
    vm = psutil.virtual_memory()
    return HardwareSnapshot(
        docker_cpus=docker_cpus,
        docker_mem_gb=docker_mem,
        host_cpus=psutil.cpu_count(logical=True) or 1,
        host_mem_total_gb=vm.total / GB,
        host_mem_avail_gb=vm.available / GB,
        host_cpu_util=psutil.cpu_percent(interval=None) / 100,
        gpus=read_gpus(),
        docker_gpu_ok=docker_gpu_ok,
    )
