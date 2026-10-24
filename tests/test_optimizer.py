from anemone.config import Config
from anemone.gpu import GPUAllocator, GPURequest
from anemone.hardware import GPUInfo, HardwareSnapshot
from anemone.history import History
from anemone.optimizer import (Resources, Tuner, boosted_cpus, compute_budget, fits, learned_size,
                                max_concurrency, size_classes)

CFG = Config()


def hw(cpus, mem, docker_cpus=None, docker_mem=None, util=0.1, gpus=()):
    return HardwareSnapshot(docker_cpus=docker_cpus if docker_cpus is not None else cpus,
                            docker_mem_gb=docker_mem if docker_mem is not None else mem,
                            host_cpus=cpus, host_mem_total_gb=mem, host_mem_avail_gb=mem * 0.6,
                            host_cpu_util=util, gpus=gpus)


def test_budget_small_machine_keeps_minimum_reserve():
    b = compute_budget(hw(4, 8), CFG)
    assert b.cpus == 2 and b.mem_gb == 5


def test_budget_big_machine_uses_fraction_reserve():
    b = compute_budget(hw(32, 32), CFG)
    assert b.cpus == 28.8
    assert abs(b.mem_gb - 27.2) < 1e-6


def test_budget_uses_docker_vm_limits_when_smaller():
    b = compute_budget(hw(32, 32, docker_cpus=32, docker_mem=16), CFG)
    assert b.mem_gb == 13


def test_sizes_scale_with_hardware():
    small_box = size_classes(compute_budget(hw(4, 8), CFG))
    big_box = size_classes(compute_budget(hw(32, 32), CFG))
    assert small_box["small"] == Resources(0.5, 0.5)
    assert big_box["small"].cpus >= small_box["small"].cpus
    assert big_box["large"].cpus == big_box["small"].cpus * 4


def test_concurrency_is_bounded_by_memory_not_overcommitted_cpu():
    b = compute_budget(hw(32, 32), CFG)
    per = Resources(1.0, 4.0)
    assert max_concurrency(b, per, CFG) == 6  # 27.2 GB / 4 GB, CPU would allow 43


def test_concurrency_respects_config_cap():
    b = compute_budget(hw(32, 32), CFG)
    assert max_concurrency(b, Resources(0.5, 0.5), Config(max_concurrency=10)) == 10


def test_fits_allows_cpu_overcommit_but_not_memory():
    b = compute_budget(hw(4, 8), CFG)  # 2 CPU, 5 GB
    assert fits(Resources(1, 1), Resources(2, 1), b, CFG)       # 3 CPU <= 2 * 1.5
    assert not fits(Resources(1, 1), Resources(2.5, 1), b, CFG)
    assert not fits(Resources(0.5, 1.5), Resources(0, 4), b, CFG)


def test_tuner_cuts_under_pressure_and_grows_with_slack():
    t = Tuner(20)
    assert t.update(20, cpu_util=0.95, mem_util=0.3, oom_recent=False, queued=5, running=20, cfg=CFG) == 15
    assert t.update(20, cpu_util=0.3, mem_util=0.9, oom_recent=False, queued=5, running=15, cfg=CFG) == 11
    assert t.update(20, cpu_util=0.3, mem_util=0.3, oom_recent=True, queued=5, running=11, cfg=CFG) == 8
    assert t.update(20, cpu_util=0.3, mem_util=0.3, oom_recent=False, queued=5, running=8, cfg=CFG) == 9
    assert t.update(20, cpu_util=0.3, mem_util=0.3, oom_recent=False, queued=0, running=9, cfg=CFG) == 9
    assert t.update(4, cpu_util=0.3, mem_util=0.3, oom_recent=False, queued=5, running=9, cfg=CFG) == 4
    t2 = Tuner(1)
    assert t2.update(1, 1.0, 1.0, True, 1, 1, CFG) == 1


def test_boost_only_when_idle():
    b = compute_budget(hw(32, 32), CFG)
    assert boosted_cpus(1.0, 0.2, b, 4, CFG) == 4.0
    assert boosted_cpus(1.0, 0.9, b, 4, CFG) == 1.0
    assert boosted_cpus(1.0, 0.2, b, 40, CFG) == 1.0


def test_learned_size_uses_p95_plus_headroom():
    assert learned_size([(0.5, 0.2)] * 2) is None
    r = learned_size([(0.2, 0.1)] * 9 + [(1.0, 1.0)])
    assert r.cpus == 1.25 and r.mem_gb == 1.25
    r = learned_size([(0.2, 0.1)] * 19 + [(1.0, 1.0)])  # a 1-in-20 outlier is past p95
    assert r.cpus == 0.25 and r.mem_gb == 0.25


def test_history_roundtrip(tmp_path):
    h = History(tmp_path / "h.db")
    h.record("k", 0.5, 0.3, 1.0, 2.0, False)
    h.record("k", 0.9, 1.0, 1.0, 2.0, True)
    assert h.samples("k") == [(0.5, 0.3)]
    assert h.last("k") == (1.0, True)
    h.close()


def test_gpu_allocator_accounts_vram():
    g = GPUAllocator((GPUInfo(0, "RTX", 12.0, 12.0, 0.0),), enabled=True)
    req = GPURequest(count=1, vram_gb=8)
    assert g.try_alloc(req) == [0]
    assert g.try_alloc(req) is None  # only 4 GB left
    assert g.try_alloc(GPURequest(vram_gb=3)) == [0]
    g.release([0], 8)
    assert g.try_alloc(req) == [0]
    assert not g.possible(GPURequest(vram_gb=16))
    assert not g.possible(GPURequest(count=2))


def test_gpu_allocator_disabled_without_docker_gpu():
    g = GPUAllocator((GPUInfo(0, "RTX", 12.0, 12.0, 0.0),), enabled=False)
    assert not g.possible(GPURequest())
