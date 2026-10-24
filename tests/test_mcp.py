"""End-to-end: start anemone-mcp as a subprocess and drive it over stdio like a real MCP client."""
import shutil
import sys
from pathlib import Path

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from tests.test_integration import CLIENT

needs_docker = pytest.mark.skipif(CLIENT is None, reason="Docker engine not running")

EXE = Path(sys.executable).with_name("anemone-mcp.exe" if sys.platform == "win32" else "anemone-mcp")


@pytest.fixture
def home(tmp_path):
    (tmp_path / "anemone.toml").write_text("tune_interval = 1.0\n")
    return tmp_path


async def _session(home):
    params = StdioServerParameters(command=str(EXE if EXE.exists() else shutil.which("anemone-mcp")), args=["--home", str(home)])
    return stdio_client(params)


async def call(s: ClientSession, name: str, **args) -> dict:
    r = await s.call_tool(name, args)
    assert not r.is_error, r.content
    return r.structured_content


@pytest.mark.docker
@needs_docker
async def test_mcp_end_to_end(home):
    async with await _session(home) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            tools = {t.name for t in (await s.list_tools()).tools}
            assert tools == {"run_task", "run_batch", "get_status", "read_artifact", "cleanup"}

            st = await call(s, "get_status")
            assert st["limit"] >= 1 and st["budget"]["cpus"] > 0

            r = await call(s, "run_task", cmd="python make.py && echo built",
                           files={"make.py": "open('out/report.txt','w').write('hello from the sandbox')"})
            assert r["status"] == "ok" and "built" in r["output"]
            assert r["artifacts"] == [{"path": "report.txt", "bytes": 22}]

            a = await call(s, "read_artifact", task_id=r["task_id"], path="report.txt")
            assert a["content"] == "hello from the sandbox"

            bad = await s.call_tool("read_artifact", {"task_id": r["task_id"], "path": "../../anemone.toml"})
            assert bad.is_error

            denied = await s.call_tool("run_task", {"cmd": "true", "network": "bridge"})
            assert denied.is_error and "network access is disabled" in str(denied.content)

            b = await call(s, "run_batch", tasks=[{"cmd": f"echo {i}"} for i in range(5)] + [{"cmd": "exit 3"}])
            assert b["ok"] == 5 and b["total"] == 6
            assert [x["output"].strip() for x in b["results"][:5]] == ["0", "1", "2", "3", "4"]
            assert b["results"][5]["status"] == "failed" and b["results"][5]["exit_code"] == 3

            t = await call(s, "run_task", cmd="sleep 30", timeout=1)
            assert t["status"] == "timed_out"

            assert (await call(s, "cleanup"))["removed"] >= 0


async def test_mcp_starts_and_explains_when_docker_is_down(home):
    async with await _session(home) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            assert len((await s.list_tools()).tools) == 5
            r = await s.call_tool("get_status", {})
            if CLIENT is None:
                assert r.is_error and "Start Docker Desktop" in str(r.content)
            else:
                assert not r.is_error