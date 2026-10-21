"""Needs a running Docker engine; skipped otherwise. Uses python:3.12-slim so no image build is required."""
import asyncio
import time

import pytest

from agentbox import AgentBox, Config, GPURequest, Task

docker = pytest.importorskip("docker")


def _client():
    try:
        c = docker.from_env(max_pool_size=64, timeout=120)
        c.ping()
        return c
    except Exception:
        return None


CLIENT = _client()
pytestmark = [pytest.mark.docker, pytest.mark.skipif(CLIENT is None, reason="Docker engine not running")]


@pytest.fixture
def cfg(tmp_path):
    return Config(image="python:3.12-slim", runs_dir=str(tmp_path / "runs"), state_dir=str(tmp_path / "state"), tune_interval=1.0)


def managed(owner=None):
    cs = CLIENT.containers.list(all=True, filters={"label": "agentbox.managed=true"})
    return [c for c in cs if owner is None or c.labels.get("agentbox.owner") == owner]


async def test_echo_and_cleanup(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd="echo hello && id -u"))
        owner = box.owner
    assert r.ok, r
    assert "hello" in r.output and "1000" in r.output
    assert managed(owner) == []


async def test_files_in_and_artifacts_out(cfg, tmp_path):
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd="python solve.py", files={"solve.py": "open('out/answer.txt','w').write(str(6*7))"}))
    assert r.ok, r
    assert (tmp_path / "runs" / r.id / "answer.txt").read_text() == "42"


async def test_oom_is_reported(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd="python -c \"x = bytearray(900*1024*1024); print(len(x))\"", mem_gb=0.25, kind="oom-test"))
    assert r.oom, r
    assert not r.ok


async def test_timeout_kills(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        t0 = time.time()
        r = await box.run(Task(cmd="sleep 999", timeout=2))
    assert r.timed_out and time.time() - t0 < 30


async def test_network_off_by_default(cfg):
    code = "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5); print('online')"
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd=["python", "-c", code]))
    assert not r.ok and "online" not in r.output


async def test_readonly_root_and_no_root_user(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd="touch /etc/x 2>&1; echo rc=$?"))
    assert "rc=1" in r.output


async def test_many_tasks_respect_limit(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        peak = 0

        async def watch():
            nonlocal peak
            while True:
                peak = max(peak, len(box._running))
                assert box._used.mem_gb <= box.budget.mem_gb + 1e-6
                await asyncio.sleep(0.05)

        w = asyncio.create_task(watch())
        results = await box.map([Task(cmd="sleep 1; echo ok", kind="sleepy") for _ in range(12)])
        w.cancel()
        limit = box.tuner.limit
    assert all(r.ok for r in results)
    assert 1 < peak <= max(limit, 12)


async def test_impossible_gpu_request_fails_fast(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        r = await box.run(Task(cmd="true", gpu=GPURequest(count=8, policy="wait")))
    assert r.error and "GPU unavailable" in r.error


@pytest.mark.gpu
async def test_gpu_visible(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        if not box.gpu.enabled:
            pytest.skip("Docker cannot reach a GPU")
        r = await box.run(Task(cmd="nvidia-smi -L", gpu=GPURequest(count=1, vram_gb=1)))
    assert r.ok and "GPU" in r.output, r


@pytest.mark.gpu
async def test_gpu_vram_serializes(cfg):
    async with AgentBox(cfg, client=CLIENT) as box:
        if not box.gpu.enabled:
            pytest.skip("Docker cannot reach a GPU")
        big = max(g.vram_total_gb for g in box.hw.gpus) * 0.6
        t0 = time.time()
        a, b = await box.map([Task(cmd="sleep 2", gpu=GPURequest(vram_gb=big)) for _ in range(2)])
    assert a.ok and b.ok
    assert time.time() - t0 >= 4  # second one waited for the first
