import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Waves } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { HoverCard, HoverCardProfile } from "@/components/arc/hover-card/hover-card";
import { formatBytes, formatSeconds, isActive, STATUS_RGB } from "@/lib/monitor";
import type { MonitorState, RunningTask } from "@/lib/monitor";
import { createEngine, shapeFor } from "@/lib/ocean";
import type { Engine, Theme } from "@/lib/ocean";

interface Props {
  state: MonitorState | null;
  connected: boolean;
  theme: Theme | null;
  selectedId: string | null;
  onEngine?: (engine: Engine) => void;
}

interface Hover { task: RunningTask; species: string; x: number; y: number }

export function OceanStage({ state, connected, theme, selectedId, onEngine }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  // Create the engine once the first theme is in; later themes swap in place.
  useEffect(() => {
    if (!theme || !canvasRef.current || !stageRef.current) return;
    if (engineRef.current) {
      engineRef.current.setTheme(theme);
      return;
    }
    let cancelled = false;
    createEngine(canvasRef.current, theme, stageRef.current).then(engine => {
      if (cancelled) return engine.destroy();
      engineRef.current = engine;
      setReady(true);
      onEngine?.(engine);
    });
    return () => { cancelled = true; };
  }, [theme, onEngine]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  // Mirror running tasks as creatures.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !theme) return;
    const st = state?.status;
    const active = isActive(state);
    const specs = active && st ? st.running.map(r => {
      const share = 0.5 * (r.cpus / st.budget.cpus + r.mem_gb / st.budget.mem_gb);
      return {
        id: r.id,
        kind: shapeFor(theme, r.kind),
        size: Math.min(1, Math.max(0.6, 0.6 + share * 3)),
        activity: r.cpus ? r.cpu_now / r.cpus : 0.5,
        label: `${r.kind} · ${r.id.slice(0, 6)}`,
      };
    }) : [];
    const finished: Record<string, number[]> = {};
    for (const e of st?.events ?? []) if (e.type === "finish" && e.status) finished[e.id] = STATUS_RGB[e.status] ?? STATUS_RGB.error;
    engine.world.sync(specs, finished);
    engine.world.queued = active && st ? Math.min(st.queued, 200) : 0;
    if (selectedId) engine.world.highlight(selectedId);
    if (engine.stillMode) engine.drawStill();
  }, [state, theme, ready, selectedId]);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || !theme) return;
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const creature = engine.world.creatureAt(x, y, 60);
    const task = creature && state?.status?.running.find(r => r.id === creature.taskId);
    setHover(task ? { task, species: creature!.kind, x, y } : null);
  };

  const words = theme?.words ?? {};

  let empty: { title: string; description: string } | null = null;
  if (!connected) empty = { title: "Monitor disconnected", description: "Lost contact with anemone ui. Is it still running in your terminal?" };
  else if (state?.mode === "offline") empty = { title: `The ${words.place ?? "ocean"} is quiet`, description: `No anemone is running in this folder. Ask Claude to use anemone, or run anemone batch, and the ${words.creatures ?? "creatures"} swim in here.` };
  else if (state?.mode === "stale") empty = { title: "Nothing new for a while", description: `The anemone that was running here stopped ${Math.round(state.age)}s ago.` };

  return (
    <div ref={stageRef} className="ocean" onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={canvasRef} className="ocean-canvas" aria-label={`Live view: each swimming ${words.creature ?? "creature"} is a running task`} role="img" />

      {hover && (
        <HoverCard
          key={hover.task.id}
          side="right"
          align="center"
          openDelay={120}
          content={
            <HoverCardProfile
              name={hover.task.kind}
              role={`Task ${hover.task.id}`}
              avatar={<Waves size={20} />}
              stats={[
                { label: "CPU", value: `${hover.task.cpu_now.toFixed(2)} / ${hover.task.cpus}` },
                { label: "Memory", value: `${formatBytes(hover.task.mem_now_gb)} / ${formatBytes(hover.task.mem_gb)}` },
              ]}
              meta={<span>Running {formatSeconds(hover.task.elapsed)} · drawn as {hover.species}{hover.task.gpus.length ? ` · GPU ${hover.task.gpus.join(", ")}` : ""}</span>}
            />
          }
        >
          <button type="button" className="ocean-probe" style={{ left: hover.x - 18, top: hover.y - 18 }} aria-label={`${hover.task.kind} task ${hover.task.id}`} />
        </HoverCard>
      )}

      {empty && (
        <div className="ocean-empty">
          <EmptyState title={empty.title} description={empty.description} icon={<Waves size={22} />} />
        </div>
      )}

    </div>
  );
}
