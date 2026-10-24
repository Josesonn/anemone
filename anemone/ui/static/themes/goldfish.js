// The "goldfish" theme: the default look of the monitor.
//
// PLACEHOLDER: the goldfish visuals are not drawn yet. The scene, skin and prey settings
// below work today; `shapes` holds one plain stand-in body so the monitor still renders.
// TODO(goldfish): replace `shapes.placeholder` with the real goldfish shapes and update `tint`/`glyphs`.
//
// A theme decides everything you SEE; the engine decides how things MOVE.
// To make your own: copy this file to themes/<name>.js, change it, then open
// the monitor with ?theme=<name> (or pick it from the menu in the corner).
// See docs/themes.md for a walkthrough of every field.

export default {
  name: "goldfish",
  // Words the dashboard uses: "3 goldfish swimming", "queued fish", ...
  words: { creature: "goldfish", creatures: "goldfish", prey: "fish", place: "ocean" },

  // ── scene ───────────────────────────────────────────────────────────
  background: "#000",
  grid: "rgba(255,255,255,0.055)",
  // Wake/ripple dots where things swim (r, g, b).
  wake: [110, 230, 255],
  // Little prey glyphs: one character per fish, brightness by depth.
  prey: { glyph: "-", rgb: [230, 238, 255], queuedRgb: [255, 190, 70] },
  // Where a fish is eaten.
  heat: { hot: [255, 120, 60], warm: [220, 40, 40], glyphs: ["·", "*"] },
  // Labels drawn next to each creature (task id).
  label: { rgb: [170, 200, 230] },
  font: '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, Consolas, monospace',

  // ── creature skin ───────────────────────────────────────────────────
  // Sparse glyphs on bright skin, dense glyphs in shadow.
  glyphs: {
    skin: ":;t%SX8#@",
    fin: "%;tS:",
    ridge: "@8%",
    edgeHeavy: ":;",
    edgeLight: ".',`",
    mark: "#%@",
    eye: "o",
  },
  eyeColor: "#9aa0ad",
  // Shimmer: how often skin cells flash an accent colour or white (0 = never, 1 = lots of
  // sparkle). Off by default: solid, calm skin.
  shimmer: 0,
  accents: ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"],

  // ── creature shapes ─────────────────────────────────────────────────
  // Each task kind is drawn as one of these (picked by hashing the kind name).
  // All values are fractions of the creature's length; s runs 0 (head) → 1 (tail).
  // See docs/themes.md for what every field means.
  shapes: {
    // TODO(goldfish): stand-in only, a plain tapered body. The fins are tiny triangles kept
    // inside the outline so none show (all-zero fins would cover the whole bounding box).
    placeholder: {
      halfWidth: (s) => 0.08 * Math.sin(Math.PI * Math.min(1, s * 1.1)) + 0.004,
      pectoral: [0.35, 0.45, 0.4, 0.01], falcate: false,
      pelvic: [0.5, 0.6, 0.55, 0.01], caudal: 0,
      dorsal: [0, 0], secondDorsal: [0, 0],
      eye: [0.06, 0.1], gills: [0, 0],
      tint: [1, 1, 1],
    },
  },

  // ── prey behaviour ──────────────────────────────────────────────────
  // How the little things school (Couzin et al. 2002): strong alignment gives
  // ribbons, low alignment gives swarms, mill > 0 makes a rotating bait ball.
  species: [
    { name: "sardine", cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3, schoolSize: [18, 28], spacing: [1.8, 1.1],
      align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5 },
    { name: "anchovy", cruise: 46, maxSpeed: 78, minSpeed: 22, weight: 3, schoolSize: [20, 32], spacing: [1.5, 1],
      align: 3.2, cohesion: 0.45, jitter: 30, mill: 0, verticalDrag: 1.4 },
    { name: "silverside", cruise: 40, maxSpeed: 70, minSpeed: 20, weight: 3, schoolSize: [12, 20], spacing: [2, 1.1],
      align: 2.4, cohesion: 1.1, jitter: 35, mill: 0, verticalDrag: 1.6 },
    { name: "mackerel", cruise: 32, maxSpeed: 60, minSpeed: 16, weight: 2, schoolSize: [5, 9], spacing: [2.6, 1.3],
      align: 2, cohesion: 0.9, jitter: 25, mill: 0, verticalDrag: 2 },
    { name: "goby", cruise: 26, maxSpeed: 56, minSpeed: 10, weight: 1, schoolSize: [8, 12], spacing: [1.4, 1.1],
      align: 0.35, cohesion: 1.4, jitter: 110, mill: 0, verticalDrag: 0.3 },
  ],
};
