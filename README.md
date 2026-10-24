# agentbox

**Self-tuning, disposable Docker sandboxes for AI agents.**

agentbox runs commands inside locked-down, throwaway containers. Each container is sized to fit the machine it runs on, and it's destroyed as soon as the command finishes. Use it from Python, from the command line, or let an AI like Claude use it directly through its built-in [MCP](https://modelcontextprotocol.io) server.

It's for running code *for real*, somewhere it can't hurt anything. That matters most when an AI is the one writing and running the code.

## Why use it

- **Safe by default.** No network, a read-only system, a non-root user, and hard limits on CPU, memory, processes and time. A runaway or malicious command can't touch your files or freeze your computer.
- **Sizes itself to your hardware.** It detects your CPUs, RAM and NVIDIA GPUs, and what Docker can actually use. From that it works out how big each sandbox should be and how many can run at once.
- **Keeps adjusting.** It runs more tasks at once when the machine has spare capacity, backs off quickly under CPU or memory pressure, and lends idle CPU to running tasks.
- **Learns from past runs.** It records how much each kind of task used, and sizes the next one to match. If a task ran out of memory, the next one gets double.
- **Shares the GPU.** Tasks can ask for a GPU and an amount of VRAM. Jobs that wouldn't fit together run one after another instead of crashing each other.
- **Cleans up after itself.** Every container is labelled, so ones left behind by a crash are removed automatically.
- **Starts fast.** A small pool of pre-started containers means tasks begin in under a second.

## Typical uses

- Let an AI assistant test the code it writes without risking your machine.
- Try a script or library from the internet in a sandbox first.
- Run dozens of experiments, test cases or student submissions in parallel, each isolated and time-limited.
- Give your own AI agents a safe "computer" to work on.
- Run local GPU workloads without two jobs fighting over VRAM.

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/), or Docker Engine on Linux, running.
- Python 3.11 or newer.
- For GPU tasks: an NVIDIA GPU with a current driver. On Windows, Docker Desktop must use the WSL 2 backend.

## Install

```bash
git clone https://github.com/Josesonn/agentbox.git
cd agentbox
python -m venv .venv
```

Activate the environment. On Windows: `.venv\Scripts\activate`. On macOS or Linux: `source .venv/bin/activate`. Then install agentbox and build the sandbox image:

```bash
pip install -e .
agentbox doctor --build
```

`agentbox doctor` checks Docker, shows the hardware it found, and shows how it will size sandboxes on your machine.

## Sandbox images

| Image | What's inside | Build with |
|---|---|---|
| `agentbox/sandbox` (default) | Debian 13, Python 3.12, pip, git, curl, gcc/g++/make | `agentbox doctor --build` |
| `agentbox/sandbox-web` | All of the above plus headless **Chromium with Python Playwright**, Node.js/npm, jq, wget, zip/unzip, sqlite3 (~2.8 GB) | `agentbox doctor --web-image` |
| `agentbox/sandbox-gpu` | CUDA runtime with Python | `agentbox doctor --gpu-image` |

Use the browser image with `--browser` on the command line or `browser: true` from Claude. Browser tasks get at least 1.5 GB of memory. Add network access (`--net bridge`, which needs `allow_network = true` for Claude) to open real websites:

```bash
agentbox run --browser --net bridge --file browse.py -- python browse.py
```

Tasks can `pip install --user` extra packages when they have network access, but the system files are read-only, so tools that need `apt` have to be built into an image.

## Command-line use

```bash
agentbox run -- python -c "print(6*7)"            # one command in a fresh sandbox
agentbox run --size medium --timeout 60 -- make    # pick a size and a time limit
agentbox run --gpu 1 --vram 4 -- nvidia-smi        # attach a GPU
agentbox run --file solve.py -- python solve.py    # copy a local file in
agentbox batch examples/stress.yaml                # many tasks, live dashboard
agentbox status                                    # watch a running agentbox
agentbox ui                                        # live ASCII-ocean monitor in your browser
agentbox gc                                        # remove leftover containers
```

Anything a command writes to `/workspace/out` is saved to `runs/<task-id>/` on your computer. Everything else disappears with the container.

## Python use

```python
import asyncio
from agentbox import AgentBox, Task

async def main():
    async with AgentBox() as box:
        r = await box.run(Task(cmd="python solve.py", files={"solve.py": "print('hi')"}))
        print(r.ok, r.output)

        results = await box.map([Task(cmd=f"echo {i}") for i in range(20)])  # runs in parallel

asyncio.run(main())
```

## Use it from Claude (MCP)

agentbox includes an MCP server, so AI apps can use it as a tool. To add it to [Claude Code](https://claude.com/claude-code), use the full path to your install:

```bash
claude mcp add agentbox --scope user -- /path/to/agentbox/.venv/bin/agentbox-mcp --home /path/to/agentbox
```

On Windows the program is `.venv\Scripts\agentbox-mcp.exe`. Then start a new session and ask, for example: *"Use agentbox to run this script and show me the output."*

| Tool | What it does |
|---|---|
| `run_task` | Run one command in a fresh sandbox |
| `run_batch` | Run many commands in parallel |
| `get_status` | Show capacity, limits and running tasks |
| `read_artifact` | Read a file a task saved |
| `cleanup` | Remove leftovers from crashed runs |

If Docker isn't running, the server still starts. Its tools tell the AI to start Docker Desktop, and they work once Docker is up.

## Monitoring UI

```bash
agentbox ui            # watch the agentbox running in this folder
```

This opens a live dashboard at `http://127.0.0.1:7400` that only your computer can reach. The background is an animated ASCII ocean, built on [ascii-sharks](https://github.com/stackedlol/ascii-sharks):

- **Each running task is a creature.** Its size follows the share of the machine it has, and it swims and hunts harder when its CPU is busy. Every task *kind* always gets the same species.
- **Queued tasks are glowing prey.**
- **When a task ends,** its creature swims off in a burst: green for ok, red for failed, orange for a timeout, purple for out of memory.
- **Hover over a shark** to see that task's CPU, memory and running time.
- **Search the running tasks** by kind, ID or image, and **click one** to open its panel: live CPU and memory against the container's limits, a minute of history, the container's image, ID, processes, network and disk I/O and sandbox settings, plus **Pause/Resume** and **Hold to stop**. Stopped tasks end with the status `stopped`. Only the monitor page can use these controls; other websites can't.
- **Hide panels** (button at the top, or press **H**) slides the windows away so you can just watch the sharks.
- **The side panel** shows running, queued, finished and failed counts, live CPU and memory gauges with a minute of history, what the running tasks have reserved, the running tasks, and an activity timeline. A notification pops up when a task fails.

The monitor is read-only. It reads what agentbox publishes in `.agentbox/` and never starts, stops or reads the output of tasks.

The panel is built from [Arc](https://uiarc.dev) components (MIT). The monitor always animates, even if your system asks apps to reduce motion.

**Different creatures.** The sharks' look lives in one file, `agentbox/ui/static/themes/sharks.js`. To swap them for something else, see [docs/themes.md](docs/themes.md).

**Changing the panel.** The panel source is in `frontend/` (React, Vite and Arc). Rebuilding it needs [Node.js](https://nodejs.org); using agentbox doesn't.

```bash
cd frontend
npm install
npm run dev     # live-reloading panel; run `agentbox ui --no-browser` alongside it
npm run build   # writes the built panel into agentbox/ui/static/app
```

## Configuration

Everything works without configuration. To change defaults, copy `agentbox.example.toml` to `agentbox.toml` and edit it. For example:

```toml
allow_network = true    # let MCP clients request internet access for a task
max_concurrency = 10    # never run more than 10 tasks at once
default_timeout = 120   # seconds before a task is killed
```

## How it works

1. **Budget:** agentbox takes what Docker can use and holds back a reserve for your computer. That reserve is `max(2 CPUs, 10%)` and `max(3 GB, 15%)` of RAM.
2. **Sizes:** the small, medium and large presets are computed from that budget, so they scale with the machine.
3. **Admission:** a task starts only when its CPU, memory and GPU fit. CPU may be oversubscribed by 1.5×, since agents spend a lot of time waiting. Memory never is.
4. **Feedback loop:** every 5 seconds it checks the load. Under pressure it cuts the number of tasks allowed at once by 25%. When there's spare capacity and work waiting, it allows one more.
5. **Run:** it takes a warm container (or creates one), resizes it for the task, copies files in, runs the command, collects `/workspace/out`, then destroys the container.

## Running the tests

```bash
pip install -e ".[test]"
pytest
```

Tests that need Docker or a GPU are skipped automatically when those aren't available.

## Security note

Docker containers are a strong barrier, not an absolute one. agentbox is built for running your own code and AI-generated code. For code from untrusted strangers, use a stronger sandbox runtime such as [gVisor](https://gvisor.dev).

## License

[MIT](LICENSE). The monitor panel uses [Arc](https://uiarc.dev) components by Elia Kuratli (MIT); their license is in `frontend/src/components/arc/LICENSE`. The monitor's ocean is adapted from [ascii-sharks](https://github.com/stackedlol/ascii-sharks) by drewdi (MIT); its license is in `agentbox/ui/static/ocean/LICENSE`.
