// The "sharks" theme: the original ascii-sharks look (MIT, (c) 2026 drewdi — see ../ocean/LICENSE).
//
// A theme decides everything you SEE; the engine decides how things MOVE.
// To make your own: copy this file to themes/<name>.js, change it, then open
// the monitor with ?theme=<name> (or pick it from the menu in the corner).
// See docs/themes.md for a walkthrough of every field.
import { hash3, smoothstep } from "../ocean/math.js";

/** Classic top-down half-width at s ∈ [0, 1] (snout → tail), as a fraction of length. */
function classicHalfWidth(s) {
  if (s < 0.13) return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95);
  if (s < 0.3) return 0.09 + 0.016 * smoothstep(0.13, 0.3, s);
  if (s < 0.84) return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25);
  const k = (s - 0.84) / 0.16;
  return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
}

export default {
  name: "sharks",
  // Words the dashboard uses: "3 sharks hunting", "queued fish", ...
  words: { creature: "shark", creatures: "sharks", prey: "fish", place: "ocean" },

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
  // Shimmer: how often skin cells flash an accent colour or white (0 = never, 1 = the
  // original ascii-sharks sparkle). Off by default: solid, calm skin.
  shimmer: 0,
  accents: ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"],

  // ── creature shapes ─────────────────────────────────────────────────
  // Each task kind is drawn as one of these (picked by hashing the kind name).
  // All values are fractions of the creature's length; s runs 0 (head) → 1 (tail).
  //   halfWidth(s)  body outline (half the width at s)
  //   pectoral      side fins: [root start, root end, tip position, reach]
  //   falcate       sickle-shaped (notched) side fins
  //   pelvic        small rear fins: [root start, root end, tip, reach]
  //   caudal        forked tail fin reach (0 = no tail fin)
  //   dorsal        bright back fin [from, to]; secondDorsal: a smaller one
  //   head          optional wide head bar (hammerheads): span, sweep, depth, notch
  //   eye, gills    [from, to] along the body; eye null = eyes on the head bar
  //   tint          skin colour multipliers (r, g, b)
  //   marking(s, v, L, across, id) optional: true where the skin has a dark marking
  //   ridges(s, across)            optional: true where the back has pale stripes
  shapes: {
    classic: {
      halfWidth: classicHalfWidth,
      pectoral: [0.15, 0.43, 0.55, 0.26], falcate: true,
      pelvic: [0.57, 0.65, 0.69, 0.085], caudal: 0.085,
      dorsal: [0.33, 0.47], secondDorsal: [0.71, 0.76],
      eye: [0.1, 0.14], gills: [0.19, 0.29],
      tint: [0.92, 0.97, 1.05],
    },
    hammerhead: {
      halfWidth: (s) => {
        if (s < 0.06) return 0.045;
        if (s < 0.3) return 0.045 + 0.061 * smoothstep(0.06, 0.3, s);
        return classicHalfWidth(s) * 0.92;
      },
      head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
      pectoral: [0.17, 0.4, 0.5, 0.22], falcate: true,
      pelvic: [0.56, 0.63, 0.67, 0.075], caudal: 0.11,
      dorsal: [0.28, 0.44], secondDorsal: [0.7, 0.74],
      eye: null, gills: [0.16, 0.26],
      tint: [0.96, 0.98, 0.9],
    },
    tiger: {
      halfWidth: (s) => {
        if (s < 0.13) return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45);
        if (s < 0.3) return 0.1 + 0.014 * smoothstep(0.13, 0.3, s);
        if (s < 0.84) return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2);
        const k = (s - 0.84) / 0.16;
        return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
      },
      pectoral: [0.15, 0.42, 0.53, 0.25], falcate: true,
      pelvic: [0.57, 0.65, 0.69, 0.085], caudal: 0.095,
      dorsal: [0.33, 0.46], secondDorsal: [0.71, 0.75],
      eye: [0.08, 0.12], gills: [0.19, 0.28],
      tint: [1.02, 0.95, 0.84],
      // Wavy vertical bars over the back half, fading out toward the head.
      marking(s, v, L, across) {
        if (s < 0.2 || s > 0.9 || across > 0.85) return false;
        const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5);
        const bar = Math.sin(s * Math.PI * 2 * 9 + wobble);
        return bar > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s);
      },
    },
    zebra: {
      halfWidth: (s) => {
        if (s < 0.1) return 0.075 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.7);
        if (s < 0.28) return 0.075 + 0.025 * smoothstep(0.1, 0.28, s);
        if (s < 0.55) return 0.022 + 0.078 * Math.pow(1 - (s - 0.28) / 0.27, 1.1);
        const k = (s - 0.55) / 0.45;
        return 0.022 * (1 - k * k) + 0.012 * Math.sin(k * Math.PI);
      },
      pectoral: [0.12, 0.3, 0.36, 0.19], falcate: false,
      pelvic: [0.42, 0.48, 0.51, 0.065], caudal: 0,
      dorsal: [0.36, 0.44], secondDorsal: [0.49, 0.53],
      eye: [0.06, 0.09], gills: [0.13, 0.2],
      tint: [1.08, 0.97, 0.74],
      ridges: (s, across) => s > 0.08 && s < 0.55 && (across < 0.1 || Math.abs(across - 0.6) < 0.08),
      // Leopard spots on a jittered grid, so they ride along with the skin.
      marking(s, v, L, across, id) {
        if (s < 0.07) return false;
        const gu = (s * L) / (L * 0.06);
        const gv = v / (L * 0.045);
        const cu = Math.floor(gu);
        const cv = Math.floor(gv);
        const jx = hash3(cu, cv, id) * 0.5 + 0.25;
        const jy = hash3(cu, cv, id + 11) * 0.5 + 0.25;
        return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.08;
      },
    },
    greathammer: {
      halfWidth: (s) => {
        if (s < 0.05) return 0.04;
        if (s < 0.3) return 0.04 + 0.07 * smoothstep(0.05, 0.3, s);
        return classicHalfWidth(s) * 0.95;
      },
      head: { span: 0.21, sweep: 0.006, depth: 0.085, notch: 0.014 },
      pectoral: [0.16, 0.38, 0.49, 0.24], falcate: true,
      pelvic: [0.55, 0.62, 0.67, 0.085], caudal: 0.13,
      dorsal: [0.24, 0.45], secondDorsal: [0.68, 0.74],
      eye: null, gills: [0.15, 0.25],
      tint: [0.86, 0.93, 1.02],
    },
    mako: {
      halfWidth: (s) => {
        if (s < 0.17) return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5);
        if (s < 0.32) return 0.088 + 0.012 * smoothstep(0.17, 0.32, s);
        if (s < 0.86) return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45);
        const k = (s - 0.86) / 0.14;
        return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI);
      },
      pectoral: [0.18, 0.4, 0.5, 0.21], falcate: true,
      pelvic: [0.58, 0.64, 0.68, 0.06], caudal: 0.13,
      dorsal: [0.34, 0.45], secondDorsal: [0.76, 0.79],
      eye: [0.11, 0.15], gills: [0.2, 0.3],
      tint: [0.78, 0.9, 1.2],
    },
    thresher: {
      halfWidth: (s) => {
        if (s < 0.08) return 0.07 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.75);
        if (s < 0.2) return 0.07 + 0.02 * smoothstep(0.08, 0.2, s);
        if (s < 0.48) return 0.012 + 0.078 * Math.pow(1 - (s - 0.2) / 0.28, 1.3);
        const k = (s - 0.48) / 0.52;
        return 0.012 * (1 - k) + 0.006 * Math.sin(k * Math.PI * 0.9) + 0.002;
      },
      pectoral: [0.12, 0.27, 0.36, 0.2], falcate: true,
      pelvic: [0.37, 0.41, 0.44, 0.045], caudal: 0,
      dorsal: [0.24, 0.32], secondDorsal: [0.45, 0.47],
      eye: [0.05, 0.1], gills: [0.11, 0.18],
      tint: [1.0, 0.9, 1.08],
    },
    nurse: {
      halfWidth: (s) => {
        if (s < 0.08) return 0.085 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.4);
        if (s < 0.3) return 0.085 + 0.02 * smoothstep(0.08, 0.3, s);
        if (s < 0.72) return 0.022 + 0.083 * Math.pow(1 - (s - 0.3) / 0.42, 1.1);
        const k = (s - 0.72) / 0.28;
        return 0.022 * (1 - k * k) + 0.014 * Math.sin(k * Math.PI);
      },
      pectoral: [0.16, 0.34, 0.4, 0.17], falcate: false,
      pelvic: [0.45, 0.52, 0.55, 0.075], caudal: 0,
      dorsal: [0.5, 0.58], secondDorsal: [0.63, 0.69],
      eye: [0.05, 0.075], gills: [0.14, 0.22],
      tint: [1.1, 0.96, 0.76],
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
