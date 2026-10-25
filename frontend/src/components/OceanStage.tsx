import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Fish, Waves } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { HoverCard, HoverCardProfile } from "@/components/arc/hover-card/hover-card";
import { formatBytes, formatSeconds, isActive, STATUS_RGB } from "@/lib/monitor";
import type { MonitorState, RunningTask } from "@/lib/monitor";
import { createEngine, shapeFor } from "@/lib/ocean";
import type { Creature, Engine, Pet, Theme } from "@/lib/ocean";

interface Props {
  state: MonitorState | null;
  connected: boolean;
  theme: Theme | null;
  selectedId: string | null;
  /** Aquarium mode: these pets swim instead of tasks, and clicking the water drops food. */
  pets: Pet[] | null;
  onEngine?: (engine: Engine) => void;
}

type Hover =
  | { type: "task"; task: RunningTask; species: string; x: number; y: number }
  | { type: "pet"; pet: Pet; creature: Creature; x: number; y: number };

export function OceanStage({ state, connected, theme, selectedId, pets, onEngine }: Props) {
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

  // Aquarium mode: the pets swim in, and a click on the water drops food instead of a splash.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.tapMode = pets ? "bait" : "splash";
    if (!pets) {
      engine.world.bait.length = 0;
      return;
    }
    engine.world.sync(pets.map((p, i) => ({ id: p.id, kind: p.kind, size: 0.75 + 0.05 * (i % 4), activity: 0.4, label: p.name })));
    engine.world.queued = 0;
  }, [pets, ready]);

  // Mirror running tasks as creatures.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !theme || pets) return;
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
  }, [state, theme, ready, selectedId, pets]);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || !theme) return;
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const creature = engine.world.creatureAt(x, y, 60);
    const pet = creature && pets?.find(p => p.id === creature.taskId);
    if (pet) return setHover({ type: "pet", pet, creature: creature!, x, y });
    const task = creature && state?.status?.running.find(r => r.id === creature.taskId);
    setHover(task ? { type: "task", task, species: creature!.kind, x, y } : null);
  };

  const words = theme?.words ?? {};

  let empty: { title: string; description: string } | null = null;
  if (pets) empty = null;
  else if (!connected) empty = { title: "Monitor disconnected", description: "Lost contact with anemone ui. Is it still running in your terminal?" };
  else if (state?.mode === "offline") empty = { title: `The ${words.place ?? "ocean"} is quiet`, description: `No anemone is running in this folder. Ask Claude to use anemone, or run anemone batch, and the ${words.creatures ?? "creatures"} swim in here.` };
  else if (state?.mode === "stale") empty = { title: "Nothing new for a while", description: `The anemone that was running here stopped ${Math.round(state.age)}s ago.` };

  return (
    <div ref={stageRef} className="ocean" onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
      <canvas
        ref={canvasRef}
        className={pets ? "ocean-canvas feeding" : "ocean-canvas"}
        aria-label={pets ? `Aquarium: ${pets.length} pet ${words.creatures ?? "creatures"}; click the water to drop food` : `Live view: each swimming ${words.creature ?? "creature"} is a running task`}
        role="img"
      />

      {hover?.type === "pet" && (
        <HoverCard
          key={hover.pet.id}
          side="right"
          align="center"
          openDelay={120}
          content={
            <HoverCardProfile
              name={hover.pet.name}
              role={`${hover.pet.kind[0].toUpperCase()}${hover.pet.kind.slice(1)} ${words.creature ?? "creature"}`}
              avatar={<Fish size={20} />}
              stats={[
                { label: "Food eaten", value: String(hover.creature.eaten ?? 0) },
                { label: "Variety", value: hover.pet.kind },
              ]}
              meta={<span>Click the water to drop food</span>}
            />
          }
        >
          <button type="button" className="ocean-probe" style={{ left: hover.x - 18, top: hover.y - 18 }} aria-label={`${hover.pet.name}, a ${hover.pet.kind} ${words.creature ?? "creature"}`} />
        </HoverCard>
      )}

      {hover?.type === "task" && (
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
