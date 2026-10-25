// The "clownfish" theme: the default look of the monitor.
//
// A theme decides everything you SEE; the engine decides how things MOVE.
// To make your own: copy this file to themes/<name>.js, change it, then open
// the monitor with ?theme=<name> (or pick it from the menu in the corner).
// See docs/themes.md for a walkthrough of every field.
import { smoothstep } from "../ocean/math.js";

/** A stout oval body seen from above: round head, widest a third of the way back, then the tail stalk. */
function clownBody(peak, waist, stalk) {
  return (s) => {
    if (s < 0.1) return (peak - 0.03) * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.55);
    if (s < 0.32) return peak - 0.03 + 0.03 * smoothstep(0.1, 0.32, s);
    if (s < waist) return stalk + (peak - stalk) * Math.pow(1 - (s - 0.32) / (waist - 0.32), 1.1);
    const k = (s - waist) / (1 - waist);
    return stalk * (1 - k) + 0.012;
  };
}

/**
 * White bands with black outlines. `bands` is a list of [from, to] along the body; `edge` is
 * the outline thickness. Returns the two functions a shape needs: band() and marking().
 */
function stripes(bands, edge) {
  return {
    band: (s) => bands.some(([a, b]) => s > a && s < b),
    marking: (s) => bands.some(([a, b]) => (s > a - edge && s <= a) || (s >= b && s < b + edge)),
  };
}

export default {
  name: "clownfish",
  // Words the dashboard uses: "3 clownfish swimming", "queued fish", ...
  words: { creature: "clownfish", creatures: "clownfish", prey: "fish", place: "reef" },

  // ── scene ───────────────────────────────────────────────────────────
  background: "#000",
  grid: "rgba(255,255,255,0.055)",
  // Wake/ripple dots where things swim (r, g, b).
  wake: [110, 230, 255],
  // Little prey glyphs: one character per fish, brightness by depth.
  prey: { glyph: "-", rgb: [230, 238, 255], queuedRgb: [255, 190, 70] },
  // Food dropped by clicking the water in aquarium mode.
  bait: { glyph: "*", rgb: [240, 190, 110] },
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
    band: ".:-",
  },
  eyeColor: "#f4f1ea",
  // Shimmer: how often skin cells flash an accent colour or white (0 = never, 1 = lots of
  // sparkle). Off by default: solid, calm skin.
  shimmer: 0,
  accents: ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"],

  // ── creature shapes ─────────────────────────────────────────────────
  // Each task kind is drawn as one of these (picked by hashing the kind name).
  // All values are fractions of the creature's length; s runs 0 (head) → 1 (tail).
  // `band(s, across)` paints white bands (drawn white whatever the tint); here the black
  // outlines around them come from `marking`. The tail is a short rounded fan: `pelvic`
  // reused as a wide fin at the stalk plus a small `caudal`.
  shapes: {
    ocellaris: {
      halfWidth: clownBody(0.17, 0.66, 0.04),
      ...stripes([[0.13, 0.2], [0.37, 0.46], [0.63, 0.69]], 0.014),
      pectoral: [0.17, 0.25, 0.32, 0.27], falcate: false,
      pelvic: [0.64, 0.84, 0.97, 0.15], caudal: 0.1,
      dorsal: [0.23, 0.35], secondDorsal: [0.49, 0.6],
      eye: [0.05, 0.1], gills: [0, 0],
      tint: [1.4, 0.58, 0.1], // bright orange
    },
    percula: {
      halfWidth: clownBody(0.17, 0.66, 0.04),
      ...stripes([[0.13, 0.21], [0.37, 0.47], [0.63, 0.69]], 0.03),
      pectoral: [0.17, 0.25, 0.32, 0.27], falcate: false,
      pelvic: [0.64, 0.84, 0.97, 0.15], caudal: 0.1,
      dorsal: [0.24, 0.34], secondDorsal: [0.5, 0.6],
      eye: [0.05, 0.1], gills: [0, 0],
      tint: [1.45, 0.48, 0.08], // red-orange with thick black outlines
    },
    maroon: {
      halfWidth: clownBody(0.185, 0.64, 0.045),
      ...stripes([[0.14, 0.18], [0.39, 0.43], [0.62, 0.65]], 0.008),
      pectoral: [0.17, 0.25, 0.32, 0.27], falcate: false,
      pelvic: [0.62, 0.84, 0.97, 0.16], caudal: 0.1,
      dorsal: [0.22, 0.36], secondDorsal: [0.46, 0.59],
      eye: [0.05, 0.1], gills: [0, 0],
      tint: [1.15, 0.3, 0.22], // deep maroon, thin white bands
    },
    tomato: {
      halfWidth: clownBody(0.18, 0.65, 0.045),
      ...stripes([[0.13, 0.19]], 0.016), // a single head band
      pectoral: [0.17, 0.25, 0.32, 0.27], falcate: false,
      pelvic: [0.63, 0.84, 0.97, 0.16], caudal: 0.1,
      dorsal: [0.22, 0.58], secondDorsal: [0.6, 0.63],
      eye: [0.05, 0.1], gills: [0, 0],
      tint: [1.45, 0.38, 0.12], // tomato red
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
