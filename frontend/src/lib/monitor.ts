import { useEffect, useRef, useState } from "react";

export type Mode = "live" | "stale" | "offline";

export interface RunningTask {
  id: string;
  kind: string;
  cpus: number;
  mem_gb: number;
  cpu_now: number;
  mem_now_gb: number;
  gpus: number[];
  elapsed: number;
  container: string | null;
  image: string;
  network: string;
  timeout: number;
  started: number;
  /** From Docker: running or paused. */
  state?: string;
}

export interface TaskEvent {
  type: "start" | "finish";
  id: string;
  kind: string;
  ts: number;
  status?: "ok" | "failed" | "error" | "timed_out" | "out_of_memory" | "stopped";
  duration?: number;
  cpus?: number;
  mem_gb?: number;
  exit_code?: number | null;
}

export interface Hardware {
  cpus: number;
  mem_gb: number;
  host_cpu_util: number;
  host_mem_util: number;
  gpus: string[];
  docker_gpu: boolean | null;
}

export interface Budget { cpus: number; mem_gb: number }

export interface Status {
  ts: number;
  hardware: Hardware;
  budget: Budget;
  limit: number;
  ceiling: number;
  reason: string;
  used: Budget;
  queued: number;
  pool: number;
  completed: number;
  failed: number;
  running: RunningTask[];
  events: TaskEvent[];
}

export interface MonitorState {
  mode: Mode;
  home: string;
  age: number;
  status: Status | null;
  docker: { ok: boolean; containers: number };
  summary: { runs_1h?: number; avg_duration_1h?: number; oom_1h?: number };
  hardware?: Hardware;
  budget?: Budget;
  ceiling?: number;
}

export interface Samples { cpu: number[]; mem: number[]; running: number[]; tasks: Record<string, { cpu: number[]; mem: number[] }> }

const HISTORY = 60;
const push = (list: number[], v: number) => [...list.slice(-(HISTORY - 1)), v];

/** Polls /api/state every second and keeps a minute of history for the sparklines. */
export function useMonitor() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [connected, setConnected] = useState(true);
  const [samples, setSamples] = useState<Samples>({ cpu: [], mem: [], running: [], tasks: {} });
  const timer = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const s: MonitorState = await r.json();
        if (!alive) return;
        setState(s);
        setConnected(true);
        const hw = s.status?.hardware ?? s.hardware;
        if (hw) {
          setSamples(prev => {
            // A minute of CPU and memory per running task, for the task panel.
            const tasks: Samples["tasks"] = {};
            for (const t of isActive(s) ? s.status!.running : []) {
              const old = prev.tasks[t.id] ?? { cpu: [], mem: [] };
              tasks[t.id] = { cpu: push(old.cpu, t.cpu_now), mem: push(old.mem, Math.round(t.mem_now_gb * 1024)) };
            }
            return {
              cpu: push(prev.cpu, Math.round(hw.host_cpu_util * 100)),
              mem: push(prev.mem, Math.round(hw.host_mem_util * 100)),
              running: push(prev.running, isActive(s) ? s.status!.running.length : 0),
              tasks,
            };
          });
        }
      } catch {
        if (alive) setConnected(false);
      } finally {
        if (alive) timer.current = window.setTimeout(tick, 1000);
      }
    };
    tick();
    return () => { alive = false; window.clearTimeout(timer.current); };
  }, []);

  return { state, connected, samples };
}

export const isActive = (s: MonitorState | null) => !!s?.status && s.mode === "live";

export const STATUS_TEXT: Record<string, string> = {
  ok: "finished", failed: "failed", error: "errored", timed_out: "timed out", out_of_memory: "ran out of memory", stopped: "was stopped",
};

/** [r, g, b] bursts in the ocean, matching the Arc tones used in the panels. */
export const STATUS_RGB: Record<string, [number, number, number]> = {
  ok: [94, 222, 150], failed: [255, 122, 110], error: [255, 122, 110], timed_out: [255, 205, 110], out_of_memory: [190, 150, 255], stopped: [150, 170, 200],
};

export function formatBytes(gb: number) {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

export function formatSeconds(s: number) {
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  state: string;
  started_at: string;
  cpu: number;
  cpu_limit: number | null;
  mem_bytes: number;
  mem_limit_bytes: number | null;
  pids: number | null;
  pids_limit: number | null;
  net_rx: number;
  net_tx: number;
  disk_read: number;
  disk_write: number;
  network: string;
  read_only: boolean;
  user: string;
  cap_drop: string[] | null;
  gpus: boolean;
}

export interface TaskDetail { task: RunningTask; container: ContainerDetail | null }

/** Pause, resume or stop a task's container. The header proves the request comes from this page. */
export async function taskAction(id: string, action: "pause" | "resume" | "stop") {
  const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "X-Agentbox": "1" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as { ok: boolean; state: string };
}

export function formatBytesRaw(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
