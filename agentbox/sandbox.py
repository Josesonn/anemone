"""One locked-down container per task: create, load files, run, collect, destroy.

/workspace and /tmp are tmpfs (RAM-backed, counted against the container's memory limit) on top of a
read-only root filesystem. Docker cannot copy into tmpfs mounts, so files move in and out through exec.
"""
from __future__ import annotations

import base64
import io
import os
import socket
import tarfile
import threading
import time
import uuid
from pathlib import Path, PurePosixPath

import psutil
from pydantic import BaseModel, Field

from .config import Config
from .gpu import GPURequest
from .optimizer import Resources

LABEL = "agentbox.managed"
CPU_PERIOD = 100_000


def owner_id() -> str:
    p = psutil.Process(os.getpid())
    return f"{socket.gethostname()}:{p.pid}:{int(p.create_time())}"


def owner_alive(owner: str) -> bool:
    try:
        host, pid, ctime = owner.split(":")
    except ValueError:
        return False
    if host != socket.gethostname():
        return True  # not ours to judge
    try:
        return int(psutil.Process(int(pid)).create_time()) == int(ctime)
    except (psutil.NoSuchProcess, ValueError):
        return False


class Task(BaseModel):
    cmd: str | list[str]
    files: dict[str, str | bytes] = Field(default_factory=dict)
    kind: str = "default"
    size: str | None = None
    cpus: float | None = None
    mem_gb: float | None = None
    gpu: GPURequest | None = None
    network: str | None = None
    timeout: float | None = None
    priority: int = 0
    image: str | None = None
    browser: bool = False  # use the browser image (headless Chromium + Playwright)
    env: dict[str, str] = Field(default_factory=dict)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])


class Result(BaseModel):
    id: str
    kind: str
    exit_code: int | None = None
    output: str = ""
    oom: bool = False
    timed_out: bool = False
    stopped: bool = False  # killed from outside agentbox, e.g. Stop in the monitor
    duration: float = 0.0
    cpus: float = 0.0
    mem_gb: float = 0.0
    cpu_peak: float = 0.0
    mem_peak_gb: float = 0.0
    gpus: list[int] = Field(default_factory=list)
    artifacts: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.oom and not self.timed_out and not self.stopped and self.error is None


def _limits(res: Resources) -> dict:
    mem = f"{max(64, int(res.mem_gb * 1024))}m"
    return {"cpu_period": CPU_PERIOD, "cpu_quota": int(res.cpus * CPU_PERIOD), "mem_limit": mem, "memswap_limit": mem}


def create_container(client, cfg: Config, image: str, network: str, res: Resources, owner: str, gpu_ids: list[int] | None = None):
    """An idle, hardened container waiting for work (`sleep infinity` under tini)."""
    from docker.types import DeviceRequest

    kw = dict(
        image=image,
        command=["sleep", "infinity"],
        detach=True,
        init=True,
        user=cfg.user,
        working_dir="/workspace",
        read_only=True,
        tmpfs={
            "/tmp": f"size={cfg.tmpfs_mb}m,mode=1777",
            "/workspace": f"size={cfg.workspace_mb}m,mode=1777",
        },
        network_mode=network,
        pids_limit=cfg.pids_limit,
        cap_drop=["ALL"],
        security_opt=["no-new-privileges"],
        environment={"HOME": "/tmp", "PYTHONDONTWRITEBYTECODE": "1"},
        labels={
            LABEL: "true",
            "agentbox.owner": owner,
            "agentbox.expires": str(time.time() + cfg.pool_ttl + cfg.default_timeout),
        },
        **_limits(res),
    )
    if gpu_ids:
        kw["device_requests"] = [DeviceRequest(device_ids=[str(i) for i in gpu_ids], capabilities=[["gpu"]])]
        kw["environment"]["NVIDIA_VISIBLE_DEVICES"] = ",".join(str(i) for i in gpu_ids)
    return client.containers.run(**kw)


def resize(container, res: Resources) -> None:
    container.update(**_limits(res))


def _exec(client, container, cmd: list[str], cfg: Config, env: dict | None = None) -> tuple[int, bytes]:
    api = client.api
    eid = api.exec_create(container.id, cmd, workdir="/workspace", user=cfg.user, environment=env or {})["Id"]
    out, err = api.exec_start(eid, demux=True)
    code = api.exec_inspect(eid)["ExitCode"]
    return code, (out or b"") if code == 0 else (out or b"") + (err or b"")


def write_files(client, container, files: dict[str, str | bytes], cfg: Config) -> None:
    for name, data in files.items():
        path = PurePosixPath("/workspace") / name
        raw = data.encode() if isinstance(data, str) else data
        b64 = base64.b64encode(raw).decode()
        _exec(client, container, ["sh", "-c", f'mkdir -p "{path.parent}" && : > "{path}"'], cfg)
        for i in range(0, len(b64), 65536):
            code, out = _exec(client, container, ["sh", "-c", f'printf %s "$0" | base64 -d >> "{path}"', b64[i:i + 65536]], cfg)
            if code != 0:
                raise RuntimeError(f"writing {name} failed: {out[-300:]!r}")


def collect_artifacts(client, container, dest: Path, cfg: Config) -> str | None:
    code, out = _exec(client, container, ["sh", "-c", "[ -d /workspace/out ] && [ -n \"$(ls -A /workspace/out)\" ] && tar -C /workspace/out -cf - ."], cfg)
    if code != 0 or not out:
        return None
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(out)) as tf:
        tf.extractall(dest, filter="data")
    return str(dest)


def _cgroup_value(client, container, cfg: Config, file: str) -> str:
    code, out = _exec(client, container, ["cat", f"/sys/fs/cgroup/{file}"], cfg)
    return out.decode(errors="replace") if code == 0 else ""


def oom_killed(client, container, cfg: Config) -> bool:
    for line in _cgroup_value(client, container, cfg, "memory.events").splitlines():
        k, _, v = line.partition(" ")
        if k == "oom_kill" and v.strip().isdigit():
            return int(v) > 0
    try:
        container.reload()
        return bool(container.attrs["State"].get("OOMKilled"))
    except Exception:
        return False


class Sampler(threading.Thread):
    """Follows `docker stats` for one container and keeps the peaks."""

    def __init__(self, container):
        super().__init__(daemon=True)
        self.c = container
        self.cpu_peak = 0.0
        self.mem_peak_gb = 0.0
        self.cpu_now = 0.0
        self.mem_now_gb = 0.0
        self.stop = threading.Event()

    def run(self) -> None:
        try:
            for s in self.c.stats(stream=True, decode=True):
                if self.stop.is_set():
                    break
                cpu, pre = s.get("cpu_stats", {}), s.get("precpu_stats", {})
                d_cpu = cpu.get("cpu_usage", {}).get("total_usage", 0) - pre.get("cpu_usage", {}).get("total_usage", 0)
                d_sys = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
                n = cpu.get("online_cpus") or 1
                if d_sys > 0 and d_cpu >= 0:
                    self.cpu_now = d_cpu / d_sys * n
                    self.cpu_peak = max(self.cpu_peak, self.cpu_now)
                mem = s.get("memory_stats", {})
                used = mem.get("usage", 0) - mem.get("stats", {}).get("inactive_file", 0)
                self.mem_now_gb = max(0, used) / 1024 ** 3
                self.mem_peak_gb = max(self.mem_peak_gb, self.mem_now_gb)
        except Exception:
            pass


def run_in(client, container, task: Task, res: Resources, cfg: Config, gpu_ids: list[int], sampler: Sampler | None = None) -> Result:
    """Run a task inside a prepared container. Blocking; call from a worker thread."""
    started = time.time()
    r = Result(id=task.id, kind=task.kind, cpus=res.cpus, mem_gb=res.mem_gb, gpus=gpu_ids)
    sampler = sampler or Sampler(container)
    if not sampler.is_alive():
        sampler.start()
    try:
        write_files(client, container, task.files, cfg)
        _exec(client, container, ["mkdir", "-p", "/workspace/out"], cfg)
        cmd = ["sh", "-c", task.cmd] if isinstance(task.cmd, str) else list(task.cmd)
        api = client.api
        eid = api.exec_create(container.id, cmd, workdir="/workspace", user=cfg.user, environment=task.env)["Id"]
        chunks: list[bytes] = []
        size = 0

        def pump() -> None:
            nonlocal size
            try:
                for chunk in api.exec_start(eid, stream=True):
                    chunks.append(chunk)
                    size += len(chunk)
                    while size > cfg.max_output_bytes and len(chunks) > 1:
                        size -= len(chunks.pop(0))
            except Exception:
                pass

        t = threading.Thread(target=pump, daemon=True)
        t.start()
        t.join(task.timeout or cfg.default_timeout)
        if t.is_alive():
            r.timed_out = True
            try:
                container.kill()
            except Exception:
                pass
            t.join(5)
        else:
            container.reload()
            if container.status not in ("running", "paused"):
                r.stopped = True  # the container was killed from outside while the command ran
                r.oom = bool(container.attrs["State"].get("OOMKilled"))
            else:
                r.exit_code = api.exec_inspect(eid)["ExitCode"]
                r.oom = oom_killed(client, container, cfg)
                r.artifacts = collect_artifacts(client, container, Path(cfg.runs_dir) / task.id, cfg)
        r.output = b"".join(chunks).decode(errors="replace")
    except Exception as e:  # docker errors, container died mid-run
        r.error = f"{type(e).__name__}: {e}"
        try:
            container.reload()
            r.oom = r.oom or bool(container.attrs["State"].get("OOMKilled"))
        except Exception:
            pass
    finally:
        sampler.stop.set()
        r.cpu_peak, r.mem_peak_gb = sampler.cpu_peak, sampler.mem_peak_gb
        r.duration = time.time() - started
    return r


def destroy(container) -> None:
    try:
        container.remove(force=True, v=True)
    except Exception:
        pass
