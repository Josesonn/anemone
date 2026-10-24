"""agentbox CLI: doctor, run, batch, status, gc."""
from __future__ import annotations

import asyncio
import json
import platform
import shlex
import time
from pathlib import Path

import typer
import yaml
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table

from . import janitor
from .config import Config
from .gpu import GPURequest
from .hardware import probe_docker_gpu, read_gpus, snapshot
from .optimizer import compute_budget, max_concurrency, size_classes
from .sandbox import Result, Task
from .scheduler import AgentBox

app = typer.Typer(add_completion=False, help="Self-tuning ephemeral Docker sandboxes for AI agents.")
con = Console()
IMAGES = Path(__file__).resolve().parent.parent / "images"


def _client():
    import docker
    try:
        c = docker.from_env(max_pool_size=64, timeout=120)
        c.ping()
        return c
    except Exception as e:
        con.print(f"[red]Docker engine not reachable[/red] ({type(e).__name__}). Start Docker Desktop, then retry.")
        raise typer.Exit(1)


def _build(client, dockerfile: str, tag: str) -> None:
    con.print(f"[bold]Building {tag}[/bold] from {dockerfile}")
    for chunk in client.api.build(path=str(IMAGES), dockerfile=dockerfile, tag=tag, rm=True, decode=True):
        if "stream" in chunk and chunk["stream"].strip():
            con.print(chunk["stream"].rstrip(), style="dim", highlight=False)
        if "error" in chunk:
            con.print(f"[red]{chunk['error']}[/red]")
            raise typer.Exit(1)


@app.command()
def doctor(build: bool = typer.Option(False, help="Build the sandbox image."),
           gpu_image: bool = typer.Option(False, "--gpu-image", help="Also build the CUDA image (several GB).")):
    """Check Docker, detect hardware and show what agentbox will do with it."""
    cfg = Config.load()
    client = _client()
    if build:
        _build(client, "sandbox.Dockerfile", cfg.image)
    if gpu_image:
        _build(client, "sandbox-gpu.Dockerfile", cfg.gpu_image)
    gpus = read_gpus()
    probe_img = cfg.image
    try:
        client.images.get(probe_img)
    except Exception:
        probe_img = "debian:bookworm-slim"
    gpu_ok = probe_docker_gpu(client, probe_img, cfg.state_path / "gpu_probe.json", max_age=0) if gpus else False
    hw = snapshot(client, gpu_ok)
    b = compute_budget(hw, cfg)
    sizes = size_classes(b)

    t = Table(title="Hardware", show_header=False)
    t.add_row("Host", f"{hw.host_cpus} threads, {hw.host_mem_total_gb:.1f} GB RAM ({hw.host_mem_avail_gb:.1f} GB free)")
    t.add_row("Docker can use", f"{hw.docker_cpus:g} CPUs, {hw.docker_mem_gb:.1f} GB")
    for g in hw.gpus:
        t.add_row(f"GPU {g.index}", f"{g.name}, {g.vram_total_gb:.1f} GB VRAM ({g.vram_free_gb:.1f} GB free)")
    t.add_row("Docker → GPU", "[green]working[/green]" if gpu_ok else ("[yellow]not reachable[/yellow]" if gpus else "no NVIDIA GPU"))
    con.print(t)

    t = Table(title="What agentbox will do")
    t.add_column("Item"); t.add_column("Value")
    t.add_row("Budget (after host reserve)", f"{b.cpus:g} CPUs, {b.mem_gb:.1f} GB")
    for k, v in sizes.items():
        t.add_row(f"Size '{k}'", f"{v.cpus:g} CPUs, {v.mem_gb:g} GB → up to {max_concurrency(b, v, cfg)} at once")
    con.print(t)

    for name in (cfg.image, cfg.gpu_image):
        try:
            client.images.get(name)
            con.print(f"[green]✓[/green] image {name}")
        except Exception:
            hint = "--gpu-image" if name == cfg.gpu_image else "--build"
            con.print(f"[yellow]•[/yellow] image {name} missing (agentbox doctor {hint})")
    if gpus and not gpu_ok:
        con.print("[yellow]Docker cannot see the GPU.[/yellow] On Windows, update the NVIDIA driver and keep Docker Desktop on the WSL 2 backend.")
    if platform.system() == "Windows" and hw.docker_mem_gb and hw.docker_mem_gb < 0.75 * hw.host_mem_total_gb:
        mem = int(hw.host_mem_total_gb * 0.8)
        con.print(Panel(
            f"[wslconfig]\nmemory={mem}GB\nprocessors={hw.host_cpus}\n",
            title="Docker's VM only gets part of your RAM. To give it more, put this in %UserProfile%\\.wslconfig, then run `wsl --shutdown`",
        ))
    if gpus:
        con.print("[dim]Note: GPU memory is shared by accounting only; consumer GPUs cannot hard-partition VRAM.[/dim]")


def _summary(r: Result) -> str:
    state = "[green]ok[/green]" if r.ok else "[red]timed out[/red]" if r.timed_out else "[red]out of memory[/red]" if r.oom else f"[red]{r.error or f'exit {r.exit_code}'}[/red]"
    gpu = f", GPU {r.gpus}" if r.gpus else ""
    art = f", files → {r.artifacts}" if r.artifacts else ""
    return f"{state} · {r.duration:.1f}s · limit {r.cpus:g} CPU/{r.mem_gb:g} GB{gpu} · peak {r.cpu_peak:.2f} CPU/{r.mem_peak_gb * 1024:.0f} MB{art}"


@app.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(ctx: typer.Context,
        size: str = typer.Option(None, help="small, medium or large"),
        cpus: float = typer.Option(None), mem: float = typer.Option(None, help="GB"),
        gpu: int = typer.Option(0, help="number of GPUs"), vram: float = typer.Option(0.0, help="GB of VRAM per GPU"),
        net: str = typer.Option(None, help="none or bridge"), timeout: float = typer.Option(None),
        image: str = typer.Option(None), kind: str = typer.Option("cli"),
        file: list[Path] = typer.Option([], help="copy a local file into /workspace")):
    """Run one command in a fresh sandbox:  agentbox run -- python -c "print(1)" """
    if not ctx.args:
        con.print("Give a command after --, e.g. agentbox run -- echo hi")
        raise typer.Exit(2)
    task = Task(cmd=shlex.join(ctx.args), size=size, cpus=cpus, mem_gb=mem, network=net, timeout=timeout, image=image, kind=kind,
                gpu=GPURequest(count=gpu, vram_gb=vram) if gpu else None, files={p.name: p.read_bytes() for p in file})

    async def go() -> Result:
        async with AgentBox(client=_client()) as box:
            return await box.run(task)

    r = asyncio.run(go())
    if r.output:
        con.print(r.output, end="", highlight=False, markup=False)
    con.print(_summary(r))
    raise typer.Exit(0 if r.ok else 1)


def _load_tasks(path: Path) -> list[Task]:
    data = yaml.safe_load(path.read_text())
    items = data["tasks"] if isinstance(data, dict) else data
    tasks = []
    for it in items:
        repeat = int(it.pop("repeat", 1))
        files = {name: (path.parent / src).read_bytes() for name, src in (it.pop("files_from", None) or {}).items()}
        for _ in range(repeat):
            t = Task(**it)
            t.files.update(files)
            tasks.append(t)
    return tasks


def _status_view(s: dict) -> Group:
    head = Table.grid(padding=(0, 2))
    head.add_row(
        f"[bold]limit[/bold] {s['limit']}/{s['ceiling']} ({s['reason']})",
        f"[bold]running[/bold] {len(s['running'])}", f"[bold]queued[/bold] {s['queued']}",
        f"[bold]done[/bold] {s['completed']}", f"[bold]failed[/bold] {s['failed']}", f"[bold]warm pool[/bold] {s['pool']}",
    )
    hw = s["hardware"]
    head.add_row(
        f"host CPU {hw['host_cpu_util']:.0%}", f"host RAM {hw['host_mem_util']:.0%}",
        f"budget {s['budget']['cpus']:g} CPU / {s['budget']['mem_gb']} GB",
        f"reserved {s['used']['cpus']:g} CPU / {s['used']['mem_gb']} GB", "", "",
    )
    t = Table(expand=True)
    for c in ("task", "kind", "CPU limit", "CPU now", "mem limit", "mem now", "GPU", "elapsed"):
        t.add_column(c)
    for r in s["running"][:30]:
        t.add_row(r["id"], r["kind"], f"{r['cpus']:g}", f"{r['cpu_now']:.2f}", f"{r['mem_gb']:g} GB", f"{r['mem_now_gb'] * 1024:.0f} MB",
                  ",".join(map(str, r["gpus"])) or "-", f"{r['elapsed']:.0f}s")
    return Group(head, t)


@app.command()
def batch(path: Path, live: bool = typer.Option(True, help="show a live dashboard")):
    """Run every task in a YAML file, as many at once as the hardware allows."""
    tasks = _load_tasks(path)

    async def go() -> list[Result]:
        async with AgentBox(client=_client()) as box:
            futs = [box.submit(t) for t in tasks]
            if live:
                with Live(_status_view(box.status()), console=con, refresh_per_second=4) as lv:
                    while not all(f.done() for f in futs):
                        await asyncio.sleep(0.5)
                        lv.update(_status_view(box.status()))
            return [await f for f in futs]

    started = time.time()
    results = asyncio.run(go())
    t = Table(title=f"{len(results)} tasks in {time.time() - started:.1f}s")
    t.add_column("task"); t.add_column("kind"); t.add_column("result")
    for r in results:
        t.add_row(r.id, r.kind, _summary(r))
    con.print(t)
    raise typer.Exit(0 if all(r.ok for r in results) else 1)


@app.command()
def status(once: bool = typer.Option(False, help="print once instead of refreshing")):
    """Live view of a running agentbox (reads .agentbox/status.json)."""
    cfg = Config.load()
    path = cfg.state_path / "status.json"

    def view():
        try:
            s = json.loads(path.read_text())
        except Exception:
            return Panel("No agentbox is running here. Start one with `agentbox batch` or the Python API.")
        if time.time() - s["ts"] > 3 * cfg.tune_interval + 5:
            return Panel("The last agentbox status is stale; the scheduler has probably exited.")
        return _status_view(s)

    if once:
        con.print(view())
        return
    try:
        with Live(view(), console=con, refresh_per_second=2) as lv:
            while True:
                time.sleep(1)
                lv.update(view())
    except KeyboardInterrupt:
        pass


@app.command()
def ui(port: int = typer.Option(7400, help="port to serve on (the next free one is used if taken)"),
       home: Path = typer.Option(None, help="agentbox folder to watch (default: current folder)"),
       no_browser: bool = typer.Option(False, "--no-browser", help="don't open a browser tab")):
    """Open the live monitor in your browser (this computer only)."""
    from .ui.server import serve
    serve(home=home, port=port, open_browser=not no_browser)


@app.command()
def gc(everything: bool = typer.Option(False, "--all", help="also remove containers owned by live processes")):
    """Remove leftover agentbox containers (dead owner or expired)."""
    n = janitor.sweep(_client(), everything=everything)
    con.print(f"Removed {n} container(s).")


if __name__ == "__main__":
    app()
