"""The monitor's web API. No Docker or browser needed."""
import json
import time

import pytest
from starlette.testclient import TestClient

from anemone.ui.server import create_app


@pytest.fixture
def home(tmp_path):
    (tmp_path / "anemone.toml").write_text("tune_interval = 1.0\n")
    return tmp_path


def client(home, host="127.0.0.1"):
    return TestClient(create_app(home), base_url=f"http://{host}")


def write_status(home, **over):
    st = {"ts": time.time(), "tune_interval": 1.0, "running": [], "events": [], "queued": 0, "limit": 4, "ceiling": 8,
          "reason": "steady", "used": {"cpus": 0, "mem_gb": 0}, "budget": {"cpus": 4, "mem_gb": 8}, "pool": 1,
          "completed": 0, "failed": 0,
          "hardware": {"cpus": 8, "mem_gb": 16, "host_cpu_util": 0.1, "host_mem_util": 0.4, "gpus": [], "docker_gpu": False}}
    st.update(over)
    (home / ".anemone").mkdir(exist_ok=True)
    (home / ".anemone" / "status.json").write_text(json.dumps(st))


def test_offline_when_nothing_has_run(home):
    s = client(home).get("/api/state").json()
    assert s["mode"] == "offline" and s["status"] is None
    assert s["budget"]["cpus"] > 0 and s["ceiling"] >= 1  # falls back to this machine's capacity


def test_live_status_is_passed_through(home):
    task = {"id": "abc123def456", "kind": "tests", "cpus": 1, "mem_gb": 0.5, "cpu_now": 0.4, "mem_now_gb": 0.1, "gpus": [], "elapsed": 2}
    write_status(home, running=[task], queued=3, events=[{"type": "start", "id": task["id"], "kind": "tests", "ts": time.time()}])
    s = client(home).get("/api/state").json()
    assert s["mode"] == "live"
    assert s["status"]["running"][0]["id"] == "abc123def456"
    assert s["status"]["queued"] == 3


def test_old_status_is_stale(home):
    write_status(home, ts=time.time() - 120)
    assert client(home).get("/api/state").json()["mode"] == "stale"


def test_page_static_and_themes(home):
    c = client(home)
    assert c.get("/").status_code == 200
    html = c.get("/").text
    assert 'id="root"' in html
    bundle = next(p for p in html.split('"') if p.startswith("/static/app/") and p.endswith(".js"))
    for path in [bundle, "/static/ocean/engine.js", "/static/ocean/world.js", "/static/ocean/renderer.js",
                 "/static/ocean/math.js", "/static/ocean/LICENSE", "/static/themes/goldfish.js"]:
        assert c.get(path).status_code == 200, path
    assert "goldfish" in c.get("/api/themes").json()["themes"]


def test_other_hostnames_are_refused(home):
    assert client(home, host="evil.example").get("/api/state").status_code == 400


def test_controls_refuse_requests_without_the_page_header(home):
    c = client(home)
    assert c.post("/api/tasks/abc/stop").status_code == 403
    assert c.post("/api/tasks/abc/stop", headers={"X-Anemone": "1", "Origin": "http://evil.example"}).status_code == 403


def test_controls_and_detail_for_unknown_task(home):
    c = client(home)
    assert c.post("/api/tasks/nope/stop", headers={"X-Anemone": "1"}).status_code == 404
    assert c.post("/api/tasks/nope/explode", headers={"X-Anemone": "1"}).status_code == 400
    assert c.get("/api/tasks/nope").status_code == 404
