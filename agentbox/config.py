"""Settings, loaded from agentbox.toml when present. Every field has a hardware-agnostic default."""
from __future__ import annotations

import tomllib
from pathlib import Path

from pydantic import BaseModel


class Config(BaseModel):
    # host reserve: max(min, fraction of total)
    reserve_cpu_min: float = 2.0
    reserve_cpu_frac: float = 0.10
    reserve_mem_min_gb: float = 3.0
    reserve_mem_frac: float = 0.15

    # agents idle a lot waiting on the model, so CPU may be oversubscribed; memory never is
    cpu_overcommit: float = 1.5
    max_concurrency: int | None = None

    # feedback loop
    tune_interval: float = 5.0
    cpu_high: float = 0.85
    mem_high: float = 0.85
    cpu_low: float = 0.60
    mem_low: float = 0.70

    # containers
    image: str = "agentbox/sandbox:latest"
    gpu_image: str = "agentbox/sandbox-gpu:latest"
    web_image: str = "agentbox/sandbox-web:latest"  # headless Chromium + Playwright, Node.js, jq, ...
    browser_min_mem_gb: float = 1.5  # Chromium needs room; browser tasks never get less
    network: str = "none"
    allow_network: bool = False  # whether MCP clients may request internet access for a task
    user: str = "1000:1000"
    pids_limit: int = 512
    tmpfs_mb: int = 256
    workspace_mb: int = 1024
    default_timeout: float = 600.0
    max_output_bytes: int = 1_000_000

    # warm pool
    pool_fraction: float = 0.10
    pool_ttl: float = 3600.0

    # paths
    runs_dir: str = "runs"
    state_dir: str = ".agentbox"

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Config":
        p = Path(path) if path else Path("agentbox.toml")
        if p.exists():
            with p.open("rb") as f:
                return cls(**tomllib.load(f))
        return cls()

    @property
    def state_path(self) -> Path:
        p = Path(self.state_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p
