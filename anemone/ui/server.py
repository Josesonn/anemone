"""anemone monitor: a small local web server for the dashboard.

It reads what a running anemone publishes in its home folder (.anemone/status.json and
history.db) plus Docker's view of anemone containers. It can pause, resume or stop a running
task's container, but only for requests from the monitor page itself, never from other websites.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from ..config import Config
from ..hardware import snapshot
from ..optimizer import compute_budget, max_concurrency, size_classes
from ..sandbox import LABEL

STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"]
ACTIONS = {"pause", "resume", "stop"}


class _Static(StaticFiles):
    """Static files; the engine and themes are revalidated on every load so edits show up on reload.
    The built app's file names carry a content hash, so those stay cacheable."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        resp = super().file_response(full_path, stat_result, scope, status_code)
        if Path(full_path).parent != STATIC / "app":
            resp.headers["Cache-Control"] = "no-cache"
        return resp


class _Cached:
    """Run an expensive check at most every `ttl` seconds."""

    def __init__(self, ttl: float, fn):
        self.ttl, self.fn = ttl, fn
        self.at, self.value = 0.0, None
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            if time.time() - self.at > self.ttl:
                try:
                    self.value = self.fn()
                except Exception:
                    self.value = None
                self.at = time.time()
            return self.value


def _cpu_percent(stats: dict) -> float:
    cpu, pre = stats.get("cpu_stats", {}), stats.get("precpu_stats", {})
    d_cpu = cpu.get("cpu_usage", {}).get("total_usage", 0) - pre.get("cpu_usage", {}).get("total_usage", 0)
    d_sys = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
    n = cpu.get("online_cpus") or 1
    return round(d_cpu / d_sys * n, 3) if d_sys > 0 and d_cpu >= 0 else 0.0


class Monitor:
    def __init__(self, cfg: Config, home: Path):
        self.cfg, self.home = cfg, home
        self.state_dir = (home / cfg.state_dir).resolve()
        self._client = None
        self.docker = _Cached(1, self._docker_check)
        self.hardware = _Cached(15, self._hardware)

    def client(self):
        import docker
        if self._client is None:
            self._client = docker.from_env(timeout=10)
        return self._client

    def _docker_check(self) -> dict:
        try:
            cs = self.client().containers.list(all=True, filters={"label": f"{LABEL}=true"})
            return {"ok": True, "containers": len(cs), "states": {c.id: c.status for c in cs}}
        except Exception:
            self._client = None
            return {"ok": False, "containers": 0, "states": {}}

    def _hardware(self) -> dict:
        client = None
        try:
            client = self.client()
        except Exception:
            pass
        hw = snapshot(client)
        b = compute_budget(hw, self.cfg)
        sizes = size_classes(b)
        return {
            "hardware": {"cpus": hw.cpus, "mem_gb": round(hw.mem_gb, 1), "host_cpu_util": round(hw.host_cpu_util, 2),
                         "host_mem_util": round(hw.host_mem_util, 2), "gpus": [g.name for g in hw.gpus], "docker_gpu": None},
            "budget": {"cpus": b.cpus, "mem_gb": round(b.mem_gb, 1)},
            "sizes": {k: {"cpus": v.cpus, "mem_gb": v.mem_gb} for k, v in sizes.items()},
            "ceiling": max_concurrency(b, sizes["small"], self.cfg),
        }

    def status(self) -> tuple[dict | None, float]:
        try:
            data = json.loads((self.state_dir / "status.json").read_text())
            return data, time.time() - float(data.get("ts", 0))
        except Exception:
            return None, 0.0

    def _history(self) -> dict:
        path = self.state_dir / "history.db"
        if not path.exists():
            return {}
        try:
            db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=1)
            try:
                n, avg, oom = db.execute("SELECT COUNT(*), AVG(duration), SUM(oom) FROM runs WHERE ts > ?", (time.time() - 3600,)).fetchone()
            finally:
                db.close()
        except sqlite3.Error:
            return {}
        return {"runs_1h": n or 0, "avg_duration_1h": round(avg or 0, 2), "oom_1h": int(oom or 0)}

    def state(self) -> dict:
        status, age = self.status()
        tune = float(status.get("tune_interval", self.cfg.tune_interval)) if status else self.cfg.tune_interval
        mode = "offline" if status is None else "stale" if age > 3 * tune + 5 else "live"
        docker = self.docker.get() or {"ok": False, "containers": 0, "states": {}}
        if status:
            for r in status.get("running", []):
                r["state"] = docker["states"].get(r.get("container") or "", "running")
        out = {"mode": mode, "home": str(self.home), "age": round(age, 1), "status": status,
               "docker": {"ok": docker["ok"], "containers": docker["containers"]}, "summary": self._history()}
        if mode != "live":
            out.update(self.hardware.get() or {})
        return out

    def find_task(self, task_id: str) -> dict | None:
        status, _ = self.status()
        for r in (status or {}).get("running", []):
            if r.get("id") == task_id:
                return r
        return None

    def container_for(self, task_id: str):
        """The Docker container running this task, if it is a live, anemone-managed one."""
        task = self.find_task(task_id)
        if not task or not task.get("container"):
            return None, task
        c = self.client().containers.get(task["container"])
        if c.labels.get(LABEL) != "true":
            return None, task
        return c, task

    def task_detail(self, task_id: str) -> dict | None:
        c, task = self.container_for(task_id)
        if task is None:
            return None
        if c is None:
            return {"task": task, "container": None}
        attrs = c.attrs
        hc = attrs.get("HostConfig", {})
        stats = c.stats(stream=False)
        mem = stats.get("memory_stats", {})
        used = max(0, mem.get("usage", 0) - mem.get("stats", {}).get("inactive_file", 0))
        nets = stats.get("networks") or {}
        blk = (stats.get("blkio_stats") or {}).get("io_service_bytes_recursive") or []
        quota, period = hc.get("CpuQuota") or 0, hc.get("CpuPeriod") or 0
        return {
            "task": task,
            "container": {
                "id": c.id, "name": c.name, "image": attrs.get("Config", {}).get("Image"), "state": c.status,
                "started_at": attrs.get("State", {}).get("StartedAt"),
                "cpu": _cpu_percent(stats), "cpu_limit": round(quota / period, 2) if quota and period else None,
                "mem_bytes": used, "mem_limit_bytes": mem.get("limit") or hc.get("Memory"),
                "pids": (stats.get("pids_stats") or {}).get("current"), "pids_limit": hc.get("PidsLimit"),
                "net_rx": sum(n.get("rx_bytes", 0) for n in nets.values()), "net_tx": sum(n.get("tx_bytes", 0) for n in nets.values()),
                "disk_read": sum(b.get("value", 0) for b in blk if b.get("op", "").lower() == "read"),
                "disk_write": sum(b.get("value", 0) for b in blk if b.get("op", "").lower() == "write"),
                "network": hc.get("NetworkMode"), "read_only": hc.get("ReadonlyRootfs"), "user": attrs.get("Config", {}).get("User"),
                "cap_drop": hc.get("CapDrop"), "gpus": bool(hc.get("DeviceRequests")),
            },
        }

    def act(self, task_id: str, action: str) -> dict:
        c, task = self.container_for(task_id)
        if c is None:
            raise LookupError("that task isn't running any more")
        # Pausing a paused task (or resuming a running one) is a no-op, not an error.
        if action == "pause" and c.status != "paused":
            c.pause()
        elif action == "resume" and c.status == "paused":
            c.unpause()
        elif action == "stop":
            if c.status == "paused":
                c.unpause()
            c.kill()
        c.reload()
        return {"ok": True, "state": c.status}


def _same_origin(request: Request) -> bool:
    """Controls only work from the monitor page: a custom header (which other sites can't send without a CORS
    preflight we never answer) and, when the browser sends one, an Origin on this machine and port."""
    if request.headers.get("x-anemone") != "1":
        return False
    origin = request.headers.get("origin")
    if origin is None:
        return True
    host = request.headers.get("host", "")
    return origin in (f"http://{host}", f"https://{host}")


def create_app(home: Path | None = None) -> Starlette:
    home = (home or Path.cwd()).resolve()
    cfg = Config.load(home / "anemone.toml")
    mon = Monitor(cfg, home)

    def index(request):
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    def api_state(request):
        return JSONResponse(mon.state(), headers={"Cache-Control": "no-store"})

    def api_themes(request):
        return JSONResponse({"themes": sorted(p.stem for p in (STATIC / "themes").glob("*.js"))})

    def api_task(request):
        try:
            detail = mon.task_detail(request.path_params["task_id"])
        except Exception as e:
            return JSONResponse({"error": f"Docker: {e}"}, status_code=502)
        if detail is None:
            return JSONResponse({"error": "that task isn't running any more"}, status_code=404)
        return JSONResponse(detail, headers={"Cache-Control": "no-store"})

    def api_action(request):
        if not _same_origin(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        action = request.path_params["action"]
        if action not in ACTIONS:
            return JSONResponse({"error": f"unknown action {action!r}"}, status_code=400)
        try:
            return JSONResponse(mon.act(request.path_params["task_id"], action))
        except LookupError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            return JSONResponse({"error": f"Docker: {e}"}, status_code=502)

    routes = [
        Route("/", index),
        Route("/api/state", api_state),
        Route("/api/themes", api_themes),
        Route("/api/tasks/{task_id:str}", api_task),
        Route("/api/tasks/{task_id:str}/{action:str}", api_action, methods=["POST"]),
        Mount("/static", _Static(directory=STATIC), name="static"),
    ]
    # Only answer requests addressed to this machine by name (blocks DNS-rebinding tricks).
    app = Starlette(routes=routes, middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=LOCAL_HOSTS)])
    app.state.monitor = mon
    return app


def serve(home: Path | None = None, port: int = 7400, open_browser: bool = True) -> None:
    import socket
    import webbrowser

    import uvicorn

    for p in range(port, port + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                port = p
                break
    url = f"http://127.0.0.1:{port}/"
    print(f"anemone monitor on {url}  (Ctrl+C to stop)", flush=True)
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(create_app(home), host="127.0.0.1", port=port, log_level="warning")
