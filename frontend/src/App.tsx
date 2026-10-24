import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Clock3, Eye, EyeOff, Play, TriangleAlert } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Card } from "@/components/arc/card/card";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import type { DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Sparkline } from "@/components/arc/sparkline/sparkline";
import { Timeline } from "@/components/arc/timeline/timeline";
import type { TimelineEvent } from "@/components/arc/timeline/timeline";
import { useToastStack } from "@/components/arc/toast-stack/toast-stack";
import { UsageMeter } from "@/components/arc/usage-meter/usage-meter";
import { SearchField } from "@/components/arc/search-field/search-field";
import { OceanStage } from "@/components/OceanStage";
import { TaskDrawer } from "@/components/TaskDrawer";
import { formatBytes, formatSeconds, isActive, STATUS_TEXT, useMonitor } from "@/lib/monitor";
import type { RunningTask, TaskEvent } from "@/lib/monitor";
import { loadTheme } from "@/lib/ocean";
import type { Engine, Theme } from "@/lib/ocean";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TABLE_ROWS = 5;
const TIMELINE_EVENTS = 6;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

type Row = RunningTask & Record<string, unknown>;

/** Group tasks by kind for the usage meters (four segments at most read clearly). */
function byKind(tasks: RunningTask[], pick: (t: RunningTask) => number) {
  const totals = new Map<string, number>();
  for (const t of tasks) totals.set(t.kind, (totals.get(t.kind) ?? 0) + pick(t));
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([kind, value]) => ({ id: kind, label: kind, value }));
  const rest = sorted.slice(3).reduce((sum, [, v]) => sum + v, 0);
  return rest > 0 ? [...top, { id: "__other", label: "Other", value: rest }] : top;
}

function toTimeline(events: TaskEvent[]): TimelineEvent[] {
  return events.slice(-TIMELINE_EVENTS).reverse().map(e => {
    const finish = e.type === "finish";
    const ok = e.status === "ok";
    return {
      id: `${e.id}-${e.type}-${e.ts}`,
      at: e.ts * 1000,
      actor: e.kind,
      title: finish ? STATUS_TEXT[e.status ?? "error"] ?? "ended" : "started",
      meta: finish ? `${e.id.slice(0, 8)} · ${formatSeconds(e.duration ?? 0)}` : `${e.id.slice(0, 8)} · ${e.cpus ?? "?"} CPU · ${formatBytes(e.mem_gb ?? 0)}`,
      icon: !finish ? <Play size={13} /> : ok ? <CheckCircle2 size={13} /> : e.status === "timed_out" ? <Clock3 size={13} /> : <TriangleAlert size={13} />,
      tone: !finish ? "neutral" : ok ? "success" : "danger",
    };
  });
}

export default function App() {
  const { state, connected, samples } = useMonitor();
  const toasts = useToastStack();
  const [theme, setTheme] = useState<Theme | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [reserved, setReserved] = useState("load");
  const [hidden, setHidden] = useState(() => store.get("agentbox.panelsHidden") === "1");
  const seen = useRef<Set<string> | null>(null);

  // Sharks by default. A different creature file in /static/themes can be tried with ?theme=<name>.
  useEffect(() => { loadTheme(new URLSearchParams(location.search).get("theme") ?? "sharks").then(setTheme); }, []);

  const togglePanels = useCallback(() => setHidden(h => { store.set("agentbox.panelsHidden", h ? "0" : "1"); return !h; }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "h" && !(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) togglePanels();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanels]);

  const onEngine = useCallback((e: Engine) => {
    (globalThis as Record<string, unknown>).agentboxMonitor = { engine: e };
  }, []);

  const active = isActive(state);
  const st = active ? state!.status! : null;
  const hw = state?.status?.hardware ?? state?.hardware;
  const running = st?.running ?? [];
  const longest = [...running].sort((a, b) => b.elapsed - a.elapsed);
  const q = query.trim().toLowerCase();
  const matches = q ? longest.filter(t => t.kind.toLowerCase().includes(q) || t.id.includes(q) || (t.image ?? "").toLowerCase().includes(q)) : longest;
  const shownRows = matches.slice(0, TABLE_ROWS);
  const openId = selected[0] ?? null;
  const openTask = openId ? running.find(t => t.id === openId) ?? null : null;

  // A toast for every task that ends badly, not for the backlog already there when the page opened.
  useEffect(() => {
    const events = state?.status?.events ?? [];
    if (seen.current === null) {
      seen.current = new Set(events.map(e => `${e.id}:${e.ts}`));
      return;
    }
    for (const e of events) {
      const key = `${e.id}:${e.ts}`;
      if (e.type !== "finish" || seen.current.has(key)) continue;
      seen.current.add(key);
      if (e.status === "ok") continue;
      toasts.toast({
        type: e.status === "timed_out" ? "warning" : "error",
        title: `${e.kind} ${STATUS_TEXT[e.status ?? "error"]}`,
        description: `Task ${e.id.slice(0, 8)} after ${formatSeconds(e.duration ?? 0)}${e.status === "failed" && e.exit_code != null ? `, exit code ${e.exit_code}` : ""}`,
      });
    }
  }, [state, toasts]);

  const columns = useMemo<DataColumn<Row>[]>(() => [
    { key: "kind", label: "Task", render: (_, r) => <span className="cell-task"><span>{r.kind}</span><small>{r.id.slice(0, 6)}</small></span> },
    { key: "cpu_now", label: "CPU", numeric: true, width: 84, render: (_, r) => `${r.cpu_now.toFixed(2)}/${r.cpus}` },
    { key: "mem_now_gb", label: "Memory", numeric: true, width: 84, render: (_, r) => formatBytes(r.mem_now_gb) },
    { key: "elapsed", label: "Time", numeric: true, width: 64, render: (_, r) => formatSeconds(r.elapsed) },
  ], []);

  const problem = !connected ? "Disconnected" : state && !state.docker.ok ? "Docker isn't running" : state?.mode === "stale" ? "Stopped" : null;
  const cpuPct = hw ? Math.round(hw.host_cpu_util * 100) : 0;
  const memPct = hw ? Math.round(hw.host_mem_util * 100) : 0;

  return (
    <div className={hidden ? "app panels-hidden" : "app"}>
      <OceanStage state={state} connected={connected} theme={theme} selectedId={selected[0] ?? null} onEngine={onEngine} />

      <div className="toolbar">
        {problem && <Badge tone="danger" size="sm">{problem}</Badge>}
        <Button size="sm" variant="secondary" onClick={togglePanels} aria-pressed={hidden} title="Show or hide the panels (H)">
          {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {hidden ? "Show panels" : "Hide panels"}
        </Button>
      </div>

      <aside className="windows left" aria-label="Overview">
        {state && !state.docker.ok && (
          <Alert tone="danger" title="Docker isn't running">Start Docker Desktop to run tasks. This page reconnects by itself.</Alert>
        )}

        <div className="metric-grid">
          <MetricCard label="Running" value={running.length} context={st ? `Limit ${st.limit} · ${st.reason}` : "Nothing running"} />
          <MetricCard label="Queued" value={st?.queued ?? 0} context={st?.queued ? "Waiting for room" : "Nothing waiting"} />
          <MetricCard label="Finished" value={st?.completed ?? 0} context={state?.summary?.runs_1h ? `Avg ${formatSeconds(state.summary.avg_duration_1h ?? 0)}` : "Since start"} />
          <MetricCard label="Failed" value={st?.failed ?? 0} context={state?.summary?.oom_1h ? `${state.summary.oom_1h} out of memory` : "Errors and timeouts"} />
        </div>

        <Card title="Resources" description={hw ? `${hw.cpus} CPUs · ${formatBytes(hw.mem_gb)}${hw.gpus.length ? ` · ${hw.gpus.join(", ")}` : ""}` : "Waiting for data"}>
          {hw && (
            <div className="card-body">
              <SegmentedControl
                label="Show"
                value={st ? reserved : "load"}
                onValueChange={setReserved}
                options={st ? [{ value: "load", label: "Load" }, { value: "cpu", label: "CPU booked" }, { value: "mem", label: "Memory booked" }] : [{ value: "load", label: "Load" }]}
              />
              {(!st || reserved === "load") && (
                <div className="pair">
                  <Sparkline label="CPU" data={samples.cpu.length > 1 ? samples.cpu : [0, 0]} value={`${cpuPct}%`} formatValue={v => `${v}%`} tone={cpuPct > 85 ? "danger" : "accent"} width={150} height={40} />
                  <Sparkline label="Memory" data={samples.mem.length > 1 ? samples.mem : [0, 0]} value={`${memPct}%`} formatValue={v => `${v}%`} tone={memPct > 88 ? "danger" : "success"} width={150} height={40} />
                </div>
              )}
              {st && reserved === "cpu" && <UsageMeter key="cpu" label="CPU" segments={byKind(running, t => t.cpus)} limit={st.budget.cpus} unit=" CPU" decimals={1} freeLabel="Free" warnAt={0.85} />}
              {st && reserved === "mem" && <UsageMeter key="mem" label="Memory" segments={byKind(running, t => t.mem_gb)} limit={st.budget.mem_gb} unit=" GB" decimals={1} freeLabel="Free" warnAt={0.85} />}
            </div>
          )}
        </Card>

      </aside>

      <aside className="windows right" aria-label="Tasks">

        <Card title="Running tasks" description={matches.length > TABLE_ROWS ? `Showing ${TABLE_ROWS} of ${matches.length} · click one for details` : running.length ? "Click one for live metrics and controls" : "Nothing running"} className="card-flush">
          <div className="card-body search">
            <SearchField label="Search tasks" placeholder="Search by kind, ID or image" value={query} onValueChange={setQuery} />
          </div>
          <div className="card-body flush">
            <SortableDataTable<Row>
              rows={shownRows as Row[]}
              columns={columns}
              rowKey="id"
              caption="Running tasks"
              emptyMessage={q ? `No running task matches “${query}”` : st ? "Nothing running right now" : "No agentbox is running"}
              defaultSort={{ key: "elapsed", direction: "desc" }}
              selectable
              selectedKeys={selected}
              onSelectionChange={keys => setSelected(keys.slice(-1))}
              itemName={{ one: "task", other: "tasks" }}
            />
          </div>
        </Card>

        <Card title="Activity" description="Latest starts and finishes" className="fill">
          <div className="card-body">
            {(state?.status?.events?.length ?? 0) > 0
              ? <Timeline events={toTimeline(state!.status!.events)} now={Date.now()} label="Task activity" timeZone={TZ} headingLevel={4} />
              : <p className="quiet">No tasks have run yet.</p>}
          </div>
        </Card>
      </aside>

      <TaskDrawer task={openTask} openId={openId} history={openId ? samples.tasks[openId] : undefined} onClose={() => setSelected([])} />
    </div>
  );
}
