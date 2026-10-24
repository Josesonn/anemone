import { useEffect, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Drawer, DrawerContent, useDrawerItem } from "@/components/arc/drawer/drawer";
import { Gauge } from "@/components/arc/gauge/gauge";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Sparkline } from "@/components/arc/sparkline/sparkline";
import { useToastStack } from "@/components/arc/toast-stack/toast-stack";
import { formatBytesRaw, formatSeconds, taskAction } from "@/lib/monitor";
import type { RunningTask, TaskDetail } from "@/lib/monitor";

interface Props {
  task: RunningTask | null;
  /** The task id the panel was opened for; stays set after the task finishes so the panel can say so. */
  openId: string | null;
  history?: { cpu: number[]; mem: number[] };
  onClose: () => void;
}

const pct = (v: number, of: number | null | undefined) => (of ? Math.min(100, Math.round((v / of) * 100)) : 0);

export function TaskDrawer({ task, openId, history, onClose }: Props) {
  const toasts = useToastStack();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useDrawerItem(task);

  // Live container numbers while the panel is open.
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/tasks/${encodeURIComponent(openId)}`, { cache: "no-store" });
        if (alive) setDetail(r.ok ? await r.json() : null);
      } catch {
        /* the next tick tries again */
      } finally {
        if (alive) timer = window.setTimeout(tick, 1500);
      }
    };
    setDetail(null);
    tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [openId]);

  const act = async (action: "pause" | "resume" | "stop") => {
    if (!openId) return;
    setBusy(true);
    try {
      const r = await taskAction(openId, action);
      if (action === "stop") {
        toasts.toast({ type: "success", title: `Stopped ${shown?.kind ?? "task"}`, description: `Task ${openId.slice(0, 8)} was killed.` });
      } else {
        setDetail(d => d && d.container ? { ...d, container: { ...d.container, state: r.state } } : d);
      }
    } catch (e) {
      toasts.toast({ type: "error", title: `Couldn't ${action} the task`, description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const c = detail?.container;
  const gone = openId !== null && task === null;
  const paused = (c?.state ?? task?.state) === "paused";
  const memMb = c ? c.mem_bytes / 1024 ** 2 : 0;
  const limitMb = c?.mem_limit_bytes ? c.mem_limit_bytes / 1024 ** 2 : (shown?.mem_gb ?? 0) * 1024;
  const left = shown ? Math.max(0, shown.timeout - shown.elapsed) : 0;

  return (
    <Drawer open={openId !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DrawerContent side="right" title={shown?.kind ?? "Task"} description={shown ? `Task ${shown.id}` : undefined} className="task-drawer">
        {shown && (
          <div className="drawer-body">
            <div className="drawer-badges">
              <Badge tone={gone ? "neutral" : paused ? "warning" : "success"} size="sm">{gone ? "Finished" : paused ? "Paused" : "Running"}</Badge>
              <Badge size="sm">{shown.network === "none" ? "No network" : `Network: ${shown.network}`}</Badge>
              {shown.gpus.length > 0 && <Badge size="sm" tone="info">GPU {shown.gpus.join(", ")}</Badge>}
            </div>

            {gone && <Alert tone="info" title="This task has finished">Its container is gone. Pick another task from the list.</Alert>}

            <div className="pair">
              <Gauge label="CPU" value={pct(c?.cpu ?? shown.cpu_now, c?.cpu_limit ?? shown.cpus)} detail={`${(c?.cpu ?? shown.cpu_now).toFixed(2)} of ${c?.cpu_limit ?? shown.cpus} cores`}
                thresholds={[{ from: 0, tone: "success", label: "OK" }, { from: 80, tone: "warning", label: "Busy" }, { from: 95, tone: "danger", label: "At limit" }]} />
              <Gauge label="Memory" value={pct(memMb || shown.mem_now_gb * 1024, limitMb)} detail={`${formatBytesRaw(c?.mem_bytes ?? shown.mem_now_gb * 1024 ** 3)} of ${formatBytesRaw(limitMb * 1024 ** 2)}`}
                thresholds={[{ from: 0, tone: "success", label: "OK" }, { from: 80, tone: "warning", label: "Tight" }, { from: 95, tone: "danger", label: "At limit" }]} />
            </div>

            <div className="pair">
              <Sparkline label="CPU cores" data={history && history.cpu.length > 1 ? history.cpu : [0, 0]} value={(c?.cpu ?? shown.cpu_now).toFixed(2)} width={150} height={40} />
              <Sparkline label="Memory MB" data={history && history.mem.length > 1 ? history.mem : [0, 0]} value={String(Math.round(memMb || shown.mem_now_gb * 1024))} tone="success" width={150} height={40} />
            </div>

            <dl className="facts">
              <div><dt>Running for</dt><dd>{formatSeconds(shown.elapsed)}</dd></div>
              <div><dt>Time left</dt><dd>{formatSeconds(left)}</dd></div>
              <div className="wide"><dt>Image</dt><dd title={c?.image ?? shown.image}>{c?.image ?? shown.image}</dd></div>
              <div><dt>Container</dt><dd className="with-copy">{(c?.id ?? shown.container ?? "—").slice(0, 12)}{(c?.id ?? shown.container) && <CopyButton value={c?.id ?? shown.container!} iconOnly variant="plain" label="Copy container ID" />}</dd></div>
              <div><dt>Processes</dt><dd>{c?.pids ?? "—"}{c?.pids_limit ? ` / ${c.pids_limit}` : ""}</dd></div>
              <div><dt>Network in / out</dt><dd>{c ? `${formatBytesRaw(c.net_rx)} / ${formatBytesRaw(c.net_tx)}` : "—"}</dd></div>
              <div><dt>Disk read / write</dt><dd>{c ? `${formatBytesRaw(c.disk_read)} / ${formatBytesRaw(c.disk_write)}` : "—"}</dd></div>
              <div className="wide"><dt>Sandbox</dt><dd>{c ? `${c.read_only ? "read-only" : "writable"} · user ${c.user || "root"} · ${c.cap_drop?.includes("ALL") ? "no privileges" : "default privileges"}` : "—"}</dd></div>
            </dl>

            <div className="drawer-actions">
              <Button variant="secondary" size="md" disabled={gone || busy || !c} onClick={() => act(paused ? "resume" : "pause")}>
                {paused ? <Play size={15} /> : <Pause size={15} />}
                {paused ? "Resume" : "Pause"}
              </Button>
              <HoldToConfirm label="Hold to stop" confirmedLabel="Stopped" tone="danger" icon={<Square size={14} />} disabled={gone || busy || !c} onConfirm={() => act("stop")} />
            </div>
            <p className="quiet small">Pausing freezes the container; its time limit keeps counting. Stopping kills it, and the task ends as stopped.</p>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
