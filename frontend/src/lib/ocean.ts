// The ASCII ocean engine and its themes are plain JavaScript files served from /static
// (anemone/ui/static/ocean, /themes) so a theme can be edited without rebuilding this app.
// They are loaded at runtime rather than bundled.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Theme {
  name: string;
  words?: { creature?: string; creatures?: string; prey?: string; place?: string };
  shapes: Record<string, unknown>;
  prey: { glyph: string; rgb: number[]; queuedRgb?: number[]; queuedGlyph?: string };
  [key: string]: unknown;
}

export interface Creature {
  taskId: string;
  kind: string;
  label: string;
  nodes: Float32Array;
  length: number;
  leaving: boolean;
  /** Bait pellets this creature has eaten (aquarium mode). */
  eaten?: number;
}

export interface Engine {
  world: {
    creatures: Creature[];
    fish: unknown[];
    bait: unknown[];
    queued: number;
    sync(specs: CreatureSpec[], finished?: Record<string, number[]>): void;
    highlight(taskId: string): void;
    creatureAt(x: number, y: number, radius?: number): Creature | null;
  };
  stillMode: boolean;
  /** What a click on the water does. */
  tapMode: "splash" | "bait";
  frames?: number;
  reducedMotion: MediaQueryList;
  ignoreReducedMotion: boolean;
  setTheme(theme: Theme): void;
  setIgnoreReducedMotion(on: boolean): void;
  drawStill(): void;
  destroy(): void;
}

export interface CreatureSpec { id: string; kind: string; size: number; activity: number; label: string }

const load = (path: string) => import(/* @vite-ignore */ path);

export async function createEngine(canvas: HTMLCanvasElement, theme: Theme, pointerTarget: HTMLElement): Promise<Engine> {
  const { OceanEngine } = await load("/static/ocean/engine.js");
  return new OceanEngine(canvas, theme, { pointerTarget }) as Engine;
}

export async function loadTheme(name: string): Promise<Theme> {
  try {
    return (await load(`/static/themes/${encodeURIComponent(name)}.js`)).default as Theme;
  } catch (error) {
    console.warn(`theme "${name}" failed to load, using clownfish`, error);
    return (await load("/static/themes/clownfish.js")).default as Theme;
  }
}

/** FNV-1a: each task kind always maps to the same creature shape. */
export function shapeFor(theme: Theme, kind: string) {
  const keys = Object.keys(theme.shapes);
  let h = 2166136261;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return keys[(h >>> 0) % keys.length];
}

/** A pet creature shown in aquarium mode, when no tasks are running. */
export interface Pet { id: string; name: string; kind: string }

const PET_NAMES = [
  "Marlowe", "Coral", "Pip", "Sunny", "Bubbles", "Ginger", "Pickle", "Biscuit", "Mango", "Tango",
  "Ziggy", "Clementine", "Poppy", "Rusty", "Sprout", "Noodle", "Paprika", "Kumquat", "Finnegan", "Saffron",
];

const shuffled = <T,>(items: T[]) => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** A fresh school of pets with new names, spread over every shape the theme has. */
export function makePets(theme: Theme, count = 6): Pet[] {
  const kinds = shuffled(Object.keys(theme.shapes));
  const batch = Date.now().toString(36);
  return shuffled(PET_NAMES).slice(0, count).map((name, i) => ({ id: `pet-${batch}-${i}`, name, kind: kinds[i % kinds.length] }));
}
