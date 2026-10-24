"""MCP server exposing agentbox to AI clients (Claude Code, Claude Desktop, ...).

Runs over stdio. stdout belongs to the MCP protocol, so nothing in here may print; logs go to stderr.

    agentbox-mcp --home C:\\path\\to\\agentbox
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from . import janitor
from .config import Config
from .gpu import GPURequest
from .sandbox import Result, Task
from .scheduler import AgentBox

log = logging.getLogger("agentbox.mcp")
MAX_OUTPUT_CHARS = 20_000
MAX_ARTIFACT_BYTES = 200_000

_box: AgentBox | None = None
_lock: asyncio.Lock | None = None


async def _get_box() -> AgentBox:
    """Start agentbox on first use, and retry on later calls if Docker was not running yet."""
    global _box, _lock
    _lock = _lock or asyncio.Lock()
    async with _lock:
        if _box is None:
            box = AgentBox(Config.load())
            try:
                await box.start()
            except Exception as e:
                raise ToolError(f"agentbox cannot start: {_explain(e)}") from e
            _box = box
            log.info("agentbox ready: limit %s, budget %s", box.tuner.limit, box.budget)
        return _box


def _explain(e: Exception) -> str:
    msg = f"{type(e).__name__}: {e}"
    low = msg.lower()
    if "docker" in low and any(k in low for k in ("connect", "pipe", "createfile", "api version", "filenotfound")):
        return "the Docker engine is not running. Start Docker Desktop, then try again."
    return msg


@asynccontextmanager
async def _lifespan(_server: MCPServer):
    try:
        await _get_box()
    except ToolError as e:
        log.warning("%s (will retry on the next tool call)", e)
    try:
        yield {}
    finally:
        if _box is not None:
            await _box.close()


server = MCPServer(
    name="agentbox",
    instructions=(
        "Runs commands in disposable, locked-down Docker containers sized to this machine's hardware. "
        "Each run gets a fresh container that is destroyed afterwards; nothing persists between runs except "
        "files the command writes to /workspace/out, which are saved and can be read with read_artifact. "
        "Network is off unless the operator enabled it. Use run_batch to run many independent commands in parallel."
    ),
    lifespan=_lifespan,
)


class TaskSpec(BaseModel):
    cmd: str = Field(description="Shell command, run with sh -c inside /workspace.")
    files: dict[str, str] = Field(default_factory=dict, description="Text files to create first, path relative to /workspace -> contents.")
    size: Literal["small", "medium", "large"] | None = Field(None, description="Resource preset. Omit to auto-size from past runs of the same kind.")
    cpus: float | None = Field(None, description="Exact CPU limit; overrides size.")
    mem_gb: float | None = Field(None, description="Exact memory limit in GB; overrides size. /workspace and /tmp count against it.")
    gpu_count: int = Field(0, description="Number of GPUs to attach (0 = none).")
    vram_gb: float = Field(0.0, description="GB of VRAM per GPU this task expects to use; used to avoid overloading the GPU.")
    network: Literal["none", "bridge"] = Field("none", description="'bridge' gives internet access; only allowed if the operator enabled it.")
    timeout: float | None = Field(None, description="Seconds before the run is killed (default 600).")
    browser: bool = Field(False, description="Use the browser image: headless Chromium with Python Playwright, plus Node.js, jq, wget, zip and sqlite3. Gets at least 1.5 GB of memory. Pair with network='bridge' to open real websites.")
    image: str | None = Field(None, description="Docker image; defaults to agentbox/sandbox (Python 3.12, git, curl, build tools), or the browser image when browser is true.")
    kind: str = Field("mcp", description="Label grouping similar runs, used to learn how much CPU/memory they need.")

    def to_task(self, allow_network: bool) -> Task:
        if self.network == "bridge" and not allow_network:
            raise ToolError("network access is disabled; set allow_network = true in agentbox.toml to enable it")
        return Task(cmd=self.cmd, files=self.files, size=self.size, cpus=self.cpus, mem_gb=self.mem_gb,
                    gpu=GPURequest(count=self.gpu_count, vram_gb=self.vram_gb) if self.gpu_count else None,
                    network=self.network, timeout=self.timeout, image=self.image, browser=self.browser, kind=self.kind)


def _summary(r: Result) -> dict[str, Any]:
    out = r.output
    truncated = len(out) > MAX_OUTPUT_CHARS
    if truncated:
        out = "[... earlier output truncated ...]\n" + out[-MAX_OUTPUT_CHARS:]
    files = []
    if r.artifacts:
        root = Path(r.artifacts)
        files = [{"path": p.relative_to(root).as_posix(), "bytes": p.stat().st_size} for p in sorted(root.rglob("*")) if p.is_file()]
    status = "ok" if r.ok else "stopped" if r.stopped else "timed_out" if r.timed_out else "out_of_memory" if r.oom else "error" if r.error else "failed"
    return {
        "task_id": r.id, "status": status, "exit_code": r.exit_code, "output": out, "output_truncated": truncated,
        "error": r.error, "duration_s": round(r.duration, 2),
        "limits": {"cpus": r.cpus, "mem_gb": r.mem_gb, "gpus": r.gpus},
        "peak": {"cpus": round(r.cpu_peak, 2), "mem_mb": round(r.mem_peak_gb * 1024)},
        "artifacts": files,
    }


@server.tool(structured_output=True, annotations=ToolAnnotations(title="Run a command in a sandbox", openWorldHint=False))
async def run_task(cmd: str, files: dict[str, str] | None = None, size: Literal["small", "medium", "large"] | None = None,
                   cpus: float | None = None, mem_gb: float | None = None, gpu_count: int = 0, vram_gb: float = 0.0,
                   network: Literal["none", "bridge"] = "none", timeout: float | None = None,
                   image: str | None = None, browser: bool = False, kind: str = "mcp") -> dict[str, Any]:
    """Run one shell command in a fresh, isolated container and return its output.

    The container has a read-only root filesystem, no network by default, runs as a non-root user and is
    destroyed when the command ends. Write files to /workspace/out to keep them (see read_artifact).
    Set browser=true for tasks that need a real browser: the image has Python Playwright with headless Chromium
    (from playwright.sync_api import sync_playwright), Node.js and npm. Pair it with network="bridge" to reach websites.
    Status is one of: ok, failed (non-zero exit), timed_out, out_of_memory, stopped (killed from the monitor), error.
    """
    box = await _get_box()
    spec = TaskSpec(cmd=cmd, files=files or {}, size=size, cpus=cpus, mem_gb=mem_gb, gpu_count=gpu_count,
                    vram_gb=vram_gb, network=network, timeout=timeout, image=image, browser=browser, kind=kind)
    return _summary(await box.run(spec.to_task(box.cfg.allow_network)))


@server.tool(structured_output=True, annotations=ToolAnnotations(title="Run many commands in parallel", openWorldHint=False))
async def run_batch(tasks: list[TaskSpec]) -> dict[str, Any]:
    """Run several independent commands at once, each in its own container.

    agentbox decides how many run at the same time based on free CPU and memory; the rest queue.
    Returns one result per task, in the same order as given.
    """
    box = await _get_box()
    if not tasks:
        return {"results": []}
    built = [t.to_task(box.cfg.allow_network) for t in tasks]
    results = await box.map(built)
    return {"results": [_summary(r) for r in results], "ok": sum(r.ok for r in results), "total": len(results)}


@server.tool(structured_output=True, annotations=ToolAnnotations(title="Sandbox capacity and activity", readOnlyHint=True, openWorldHint=False))
async def get_status() -> dict[str, Any]:
    """Show the machine's capacity and what agentbox is doing: hardware, resource budget, size presets,
    how many tasks may run at once and why, and the tasks currently running or queued."""
    return (await _get_box()).status()


def _artifact_dir(box: AgentBox, task_id: str) -> Path:
    if not task_id.isalnum():
        raise ToolError("invalid task_id")
    d = (Path(box.cfg.runs_dir) / task_id).resolve()
    if not d.is_dir():
        raise ToolError(f"no saved files for task {task_id}")
    return d


@server.tool(structured_output=True, annotations=ToolAnnotations(title="Read a saved output file", readOnlyHint=True, openWorldHint=False))
async def read_artifact(task_id: str, path: str, max_bytes: int = 50_000) -> dict[str, Any]:
    """Read a file a task saved to /workspace/out. `path` is relative to that folder, as listed in the
    task's `artifacts`. Text is returned as-is; binary files are reported but not returned."""
    box = await _get_box()
    root = _artifact_dir(box, task_id)
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ToolError(f"{path} is not a saved file of task {task_id}")
    limit = max(1, min(max_bytes, MAX_ARTIFACT_BYTES))
    data = target.read_bytes()
    try:
        text = data[:limit].decode("utf-8")
    except UnicodeDecodeError:
        return {"path": path, "bytes": len(data), "binary": True, "content": None}
    return {"path": path, "bytes": len(data), "binary": False, "truncated": len(data) > limit, "content": text}


@server.tool(structured_output=True, annotations=ToolAnnotations(title="Clean up leftover containers", destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def cleanup() -> dict[str, Any]:
    """Remove agentbox containers left behind by crashed or killed runs. Never touches containers that
    belong to a running agentbox, including this one."""
    box = await _get_box()
    removed = await asyncio.to_thread(janitor.sweep, box.client, False, box.owner)
    return {"removed": removed}


def main() -> None:
    ap = argparse.ArgumentParser(prog="agentbox-mcp", description="agentbox MCP server (stdio)")
    ap.add_argument("--home", default=os.environ.get("AGENTBOX_HOME"),
                    help="folder holding agentbox.toml, runs/ and .agentbox/ (default: current folder)")
    args = ap.parse_args()
    if args.home:
        os.chdir(Path(args.home).expanduser())
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    server.run("stdio")


if __name__ == "__main__":
    main()
