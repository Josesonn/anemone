// Ported from ascii-sharks (MIT, (c) 2026 drewdi) — see ./LICENSE.
// Changes for agentbox: every colour, glyph and shape comes from the theme, plus task
// labels, coloured "task finished" bursts and highlighted (queued) prey.
/**
 * Draws the World as a grid of ASCII cells:
 *   1. a cell grid in the theme's background colour
 *   2. a wake field that diffuses where things swim, lighting dots
 *   3. prey as single glyphs, one per cell, glinting on hard turns
 *   4. creatures rasterised cell-by-cell with supersampled edges: blocks shaded by
 *      the light, dense glyphs, and shimmering accent colours
 *   5. labels and bursts on top
 */
import { clamp, hash3 } from "./math.js";
import { NODES } from "./world.js";

const ALPHA_LEVELS = 6;
const FISH_ALPHAS = [0.28, 0.42, 0.58, 0.74, 0.9];
const FLAG_BODY = 1;
const FLAG_EDGE = 2;
const FLAG_FIN = 3;
const FLAG_RIDGE = 4;
const FLAG_EYE = 5;
const FLAG_MARK = 6;
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];
const BURST_LIFE = 1.6;

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const rgb = ([r, g, b], a = 1) => (a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3)})`);

export class AsciiRenderer {
  constructor(canvas, theme) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.cw = 12;
    this.ch = 18;
    this.cols = 0;
    this.rows = 0;
    this.fontFamily = "ui-monospace, Menlo, monospace";
    this.energy = new Float32Array(0);
    this.energyTmp = new Float32Array(0);
    this.heat = new Float32Array(0);
    this.dotPhase = new Float32Array(0);
    this.dotFreq = new Float32Array(0);
    this.sharkFlag = new Uint8Array(0);
    this.sharkShade = new Float32Array(0);
    this.sharkKey = new Uint32Array(0);
    this.sharkDepth = new Float32Array(0);
    this.sharkKind = new Uint8Array(0);
    this.sharkShadow = new Uint8Array(0);
    this.fishStamp = new Uint32Array(0);
    this.spine = new Float32Array(NODES * 2);
    this.arc = new Float32Array(NODES);
    this.arcTotal = 1;
    this.sharkId = 0;
    this.finTipLeft = 0;
    this.finTipRight = 0;
    this.hitFlag = 0;
    this.hitShade = 0;
    this.hitS = 0;
    this.hitV = 0;
    this.hitDist = 0;
    this.frameId = 0;
    this.fishBuckets = FISH_ALPHAS.map(() => []);
    this.taggedCells = [];
    this.bursts = [];
    this.setTheme(theme);
  }

  setTheme(theme) {
    this.theme = theme;
    this.shapes = theme.shapes;
    this.kinds = Object.keys(theme.shapes);
    this.shape = this.shapes[this.kinds[0]];
    this.wakeStyles = [];
    for (let l = 0; l < ALPHA_LEVELS; l++) this.wakeStyles.push(rgb(theme.wake, (l + 1) / ALPHA_LEVELS));
    this.fishStyles = FISH_ALPHAS.map((a) => rgb(theme.prey.rgb, a));
    this.taggedStyle = rgb(theme.prey.queuedRgb ?? [255, 190, 70], 1);
    if (theme.font) this.fontFamily = theme.font;
    if (this.width) this.paintBackground();
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family) {
    if (family && !this.theme.font) this.fontFamily = family;
  }

  /** Index of a task kind's shape: stable per kind name, so "tests" always looks the same. */
  kindIndex(kind) {
    const i = this.kinds.indexOf(kind);
    return i >= 0 ? i : 0;
  }

  resize(width, height, dpr) {
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    const n = this.cols * this.rows;
    if (this.cols !== prevCols || this.rows !== prevRows) {
      this.energy = new Float32Array(n);
      this.energyTmp = new Float32Array(n);
      this.heat = new Float32Array(n);
      this.dotPhase = new Float32Array(n);
      this.dotFreq = new Float32Array(n);
      this.sharkFlag = new Uint8Array(n);
      this.sharkShade = new Float32Array(n);
      this.sharkKey = new Uint32Array(n);
      this.sharkDepth = new Float32Array(n);
      this.sharkKind = new Uint8Array(n);
      this.sharkShadow = new Uint8Array(n);
      this.fishStamp = new Uint32Array(n);
    }
    for (let i = 0; i < n; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2;
      this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1;
    }
    this.paintBackground();
  }

  paintBackground() {
    const g = this.bg.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.theme.background;
    g.fillRect(0, 0, W, H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = this.theme.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 0; c <= Math.ceil(W / cw); c++) {
      const x = Math.round(c * cw * dpr) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, H * dpr);
    }
    for (let r = 0; r <= Math.ceil(H / ch); r++) {
      const y = Math.round(r * ch * dpr) + 0.5;
      g.moveTo(0, y);
      g.lineTo(W * dpr, y);
    }
    g.stroke();
  }

  render(world, dt) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = world.time;
    this.consumeEvents(world);
    this.rasterizeSharks(world.sharks, t);
    this.depositWake(world);
    this.diffuse(dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markFish(world);
    this.drawWake();

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.drawHeat();
    this.drawFish();
    this.drawSharks(t);
    this.drawBursts(t);
    this.drawLabels(world);
  }

  // ── simulation → field ──────────────────────────────────────────────

  cellIndex(x, y) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  stamp(field, x, y, radius, amount) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  consumeEvents(world) {
    for (const e of world.events) {
      if (e.kind === "eat") {
        this.stamp(this.heat, e.x, e.y, 2, 1);
        this.stamp(this.energy, e.x, e.y, 3, 0.9);
      } else if (e.kind === "burst") {
        this.bursts.push({ x: e.x, y: e.y, rgb: e.rgb, t0: world.time });
        this.stamp(this.energy, e.x, e.y, 5, 1.2);
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4);
      }
    }
    world.events.length = 0;
  }

  depositWake(world) {
    const { energy } = this;
    for (const f of world.fish) {
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03);
    }
    for (const sh of world.sharks) {
      for (let k = NODES - 6; k < NODES; k++) {
        const i = this.cellIndex(sh.nodes[k * 2], sh.nodes[k * 2 + 1]);
        if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.05 + sh.speed * 0.0012);
      }
    }
    if (world.pointer.active) this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
  }

  /** Blur + decay so wakes spread out like ripples and fade. */
  diffuse(dt) {
    const { cols, rows, energy, energyTmp: tmp, heat } = this;
    const decay = Math.exp(-dt * 1.5);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1] : energy[i];
        const rt = c < cols - 1 ? energy[i + 1] : energy[i];
        const u = r > 0 ? energy[i - cols] : energy[i];
        const d = r < rows - 1 ? energy[i + cols] : energy[i];
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] *= heatDecay;
  }

  // ── creatures ───────────────────────────────────────────────────────

  /**
   * Classify one point against the current creature (spine/arc already built).
   * Body coordinates: s along the spine (0 head → 1 tail), v across it.
   */
  sampleShark(px, py, L) {
    const { spine, arc } = this;
    let best = Infinity;
    let bestS = 0;
    let bestSign = 1;
    let bestNx = 0;
    let bestNy = 0;
    for (let k = 0; k < NODES - 1; k++) {
      const ax = spine[k * 2];
      const ay = spine[k * 2 + 1];
      const sx = spine[(k + 1) * 2] - ax;
      const sy = spine[(k + 1) * 2 + 1] - ay;
      const len2 = sx * sx + sy * sy || 1;
      const u = clamp(((px - ax) * sx + (py - ay) * sy) / len2, 0, 1);
      const qx = ax + sx * u;
      const qy = ay + sy * u;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 < best) {
        best = d2;
        const len = Math.sqrt(len2);
        bestS = (arc[k] + u * len) / this.arcTotal;
        bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1;
        bestNx = (-sy / len) * bestSign;
        bestNy = (sx / len) * bestSign;
      }
    }

    const a = Math.sqrt(best);
    const s = bestS;
    const u = s * L;
    const shape = this.shape;
    const w = shape.halfWidth(s) * L;
    this.hitDist = a;
    this.hitS = s;
    this.hitV = a * bestSign;

    const head = shape.head;
    if (head && u < L * (head.sweep + head.depth + head.notch)) {
      const span = L * head.span;
      const r = a / span;
      const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14);
      const depth = L * head.depth * (1 - 0.2 * r * r * r * r);
      if (r <= 1 && u >= front && u <= front + depth) {
        this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY;
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0);
        return true;
      }
    }

    if (a <= w) {
      const across = a / (w || 1);
      const facing = (bestNx * -0.6 + bestNy * -0.8) * across;
      let shade = 0.58 - across * across * 0.42 + facing * 0.26;
      let flag = FLAG_BODY;
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
        flag = FLAG_RIDGE;
        shade = 1;
      } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
        shade = Math.max(shade, 0.82);
      } else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
        flag = FLAG_EYE;
        shade = 0;
      } else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
        if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45;
      } else if (s < 0.05) {
        shade = Math.max(shade, 0.7);
      } else if (shape.ridges && shape.ridges(s, across)) {
        shade = Math.max(shade, 0.8);
      } else if (shape.marking && shape.marking(s, a * bestSign, L, across, this.sharkId)) {
        flag = FLAG_MARK;
      }
      this.hitFlag = flag;
      this.hitShade = shade;
      return true;
    }

    const tip = bestSign > 0 ? this.finTipRight : this.finTipLeft;
    const [p0, p1, p2] = shape.pectoral;
    if (
      inTriangle(u, a, L * p0, 0, L * p1, 0, L * p2, tip) &&
      !(shape.falcate && inTriangle(u, a, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
    ) {
      this.hitFlag = shape.marking && shape.marking(s, a * bestSign, L, 0, this.sharkId) ? FLAG_MARK : FLAG_FIN;
      this.hitShade = 0.38 + 0.22 * (1 - clamp(a / tip, 0, 1));
      return true;
    }
    const [v0, v1, v2, vr] = shape.pelvic;
    if (
      inTriangle(u, a, L * v0, 0, L * v1, 0, L * v2, L * vr) ||
      (shape.caudal > 0 && inTriangle(u, a, L * 0.86, 0, L * 0.95, 0, L, L * shape.caudal))
    ) {
      this.hitFlag = FLAG_FIN;
      this.hitShade = 0.36;
      return true;
    }
    return false;
  }

  /**
   * Build a smooth, undulating render spine from the sim spine, then supersample every
   * cell in the creature's bounding box against its shape.
   */
  rasterizeSharks(sharks, t) {
    const { sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkShadow, spine, arc, cw, ch, cols, rows } = this;
    sharkFlag.fill(0);
    sharkShadow.fill(0);

    for (const sh of sharks) {
      const L = sh.length;
      const n = sh.nodes;
      const swim = clamp(sh.speed / 60, 0.4, 1.4);
      const kindIndex = this.kindIndex(sh.kind);
      this.shape = this.shapes[this.kinds[kindIndex]];
      this.sharkId = sh.id;

      for (let k = 0; k < NODES; k++) {
        const s = k / (NODES - 1);
        const a = Math.max(0, k - 1);
        const b = Math.min(NODES - 1, k + 1);
        let tx = n[a * 2] - n[b * 2];
        let ty = n[a * 2 + 1] - n[b * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const amp = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim;
        const off = amp * Math.sin(sh.phase - s * 5.2);
        spine[k * 2] = n[k * 2] - ty * off;
        spine[k * 2 + 1] = n[k * 2 + 1] + tx * off;
      }
      arc[0] = 0;
      for (let k = 1; k < NODES; k++) {
        arc[k] = arc[k - 1] + Math.hypot(spine[k * 2] - spine[(k - 1) * 2], spine[k * 2 + 1] - spine[(k - 1) * 2 + 1]);
      }
      this.arcTotal = arc[NODES - 1] || 1;

      const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
      const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5);
      const reachFin = this.shape.pectoral[3];
      this.finTipRight = L * reachFin * flex * (1 - bank);
      this.finTipLeft = L * reachFin * flex * (1 + bank);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < NODES; k++) {
        minX = Math.min(minX, spine[k * 2]);
        maxX = Math.max(maxX, spine[k * 2]);
        minY = Math.min(minY, spine[k * 2 + 1]);
        maxY = Math.max(maxY, spine[k * 2 + 1]);
      }
      const reach = L * 0.36;
      const c0 = Math.max(0, Math.floor((minX - reach) / cw));
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
      const r0 = Math.max(0, Math.floor((minY - reach) / ch));
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
      if (c0 > c1 || r0 > r1) continue;

      const skipBeyond = reach + Math.hypot(cw, ch);
      const shadowDc = Math.round((L * 0.035) / cw) + 1;
      const shadowDr = Math.round((L * 0.02) / ch) + 1;

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sampleShark(x + cw / 2, y + ch / 2, L);
          if (!centerHit && this.hitDist > skipBeyond) continue;
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const s = this.hitS;
          const v = this.hitV;
          let hits = centerHit ? 1 : 0;
          for (let k = 0; k < SUBSAMPLES.length; k += 2) {
            if (this.sampleShark(x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch, L)) hits++;
          }
          if (hits === 0) continue;
          const coverage = hits / 5;
          const i = r * cols + c;
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
          sharkKey[i] = key;
          sharkDepth[i] = sh.depth;
          sharkKind[i] = kindIndex;
          if (centerHit && coverage >= 0.6) {
            sharkFlag[i] = flag;
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
            sharkShade[i] = clamp(shade + flicker, 0, 1);
            const sc = c + shadowDc;
            const sr = r + shadowDr;
            if (sc < cols && sr < rows) sharkShadow[sr * cols + sc] = 1;
          } else {
            sharkFlag[i] = FLAG_EDGE;
            sharkShade[i] = coverage;
          }
        }
      }
    }
  }

  drawSharks(t) {
    const { ctx, cols, rows, cw, ch, sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind } = this;
    const { glyphs, accents, eyeColor } = this.theme;
    // Chance that a skin cell flashes an accent colour; 0 turns the shimmer off.
    const shimmer = this.theme.shimmer ?? 0;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const flag = sharkFlag[i];
      if (!flag) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = sharkKey[i];
      const shade = sharkShade[i];
      const dim = 0.7 + 0.3 * sharkDepth[i];
      const [tr, tg, tb] = this.shapes[this.kinds[sharkKind[i]]].tint;
      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === FLAG_EDGE) {
        const set = shade >= 0.5 ? glyphs.edgeHeavy : glyphs.edgeLight;
        const g = (70 + shade * 80) * dim;
        ctx.fillStyle =
          roll < 0.07 * shimmer
            ? accents[key % accents.length]
            : `rgb(${Math.round(g * tr)},${Math.round(g * tg)},${Math.min(255, Math.round(g * tb + 6))})`;
        ctx.fillText(set[(key >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
        continue;
      }

      let level;
      let glyph;
      if (flag === FLAG_RIDGE) {
        level = 226;
        glyph = glyphs.ridge[(key >>> 8) % glyphs.ridge.length];
      } else if (flag === FLAG_EYE) {
        level = 12;
        glyph = glyphs.eye;
      } else if (flag === FLAG_MARK) {
        level = 24 + shade * 22;
        glyph = glyphs.mark[(key >>> 8) % glyphs.mark.length];
      } else if (flag === FLAG_FIN) {
        level = 40 + shade * 120;
        glyph = glyphs.fin[(key >>> 8) % glyphs.fin.length];
      } else {
        level = 46 + shade * 160;
        const jitter = ((key >>> 4) % 3) - 1;
        glyph = glyphs.skin[clamp(Math.floor((1 - shade) * (glyphs.skin.length - 0.01)) + jitter, 0, glyphs.skin.length - 1)];
      }
      level *= dim;
      ctx.fillStyle = `rgb(${Math.min(255, Math.round(level * tr))},${Math.min(255, Math.round(level * tg))},${Math.min(255, Math.round(level * tb + 4))})`;
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);

      let color;
      if (flag === FLAG_EYE) color = eyeColor;
      else if (flag === FLAG_MARK) color = `rgb(${Math.round(70 * tr)},${Math.round(70 * tg)},${Math.round(70 * tb)})`;
      else if (roll < 0.09 * shimmer) color = accents[key % accents.length];
      else if (roll < 0.13 * shimmer) color = "#ffffff";
      else color = shade > 0.55 ? "#0e0f13" : "#1b1d24";
      ctx.fillStyle = color;
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
  }

  // ── prey, wake, heat, bursts, labels ────────────────────────────────

  markFish(world) {
    const { fishStamp, fishBuckets, sharkFlag, taggedCells } = this;
    const frame = ++this.frameId;
    for (const bucket of fishBuckets) bucket.length = 0;
    taggedCells.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const f of world.fish) {
        if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass) continue;
        const i = this.cellIndex(f.x, f.y);
        if (i < 0 || fishStamp[i] === frame || sharkFlag[i]) continue;
        fishStamp[i] = frame;
        if (f.tagged) {
          taggedCells.push(i);
          continue;
        }
        const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
        const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
        fishBuckets[clamp(Math.floor(v * FISH_ALPHAS.length), 0, FISH_ALPHAS.length - 1)].push(i);
      }
    }
  }

  drawFish() {
    const { ctx, cw, ch, cols, fishBuckets, taggedCells } = this;
    const glyph = this.theme.prey.glyph;
    for (let b = 0; b < fishBuckets.length; b++) {
      const bucket = fishBuckets[b];
      if (!bucket.length) continue;
      ctx.fillStyle = this.fishStyles[b];
      for (const i of bucket) ctx.fillText(glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
    if (taggedCells.length) {
      ctx.fillStyle = this.taggedStyle;
      for (const i of taggedCells) ctx.fillText(this.theme.prey.queuedGlyph ?? "=", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  drawHeat() {
    const { ctx, heat, cols, cw, ch } = this;
    const { hot, warm, glyphs } = this.theme.heat;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i];
      if (h < 0.08) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      ctx.fillStyle = h > 0.5 ? rgb(hot, Math.min(1, h)) : rgb(warm, Math.min(1, h * 1.6));
      ctx.fillText(h > 0.6 ? glyphs[1] : glyphs[0], col * cw + cw / 2, row * ch + ch / 2 + 1);
    }
  }

  /** Wake dots: cells where the wake field is strong light up in the theme's wake colour. */
  drawWake() {
    const { ctx, cols, rows, cw, ch, energy, sharkFlag, fishStamp, frameId } = this;
    const small = Math.max(2, Math.round(cw * 0.19));
    const size = small + 1;
    for (let l = 0; l < ALPHA_LEVELS; l++) {
      ctx.fillStyle = this.wakeStyles[l];
      for (let i = 0; i < cols * rows; i++) {
        const e = energy[i];
        if (e <= 0.45 || sharkFlag[i] || fishStamp[i] === frameId) continue;
        if (clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1) !== l) continue;
        const col = i % cols;
        const row = (i / cols) | 0;
        ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }

  /** An expanding ring of glyphs where a task finished, in the colour of how it ended. */
  drawBursts(t) {
    const { ctx, cw, ch } = this;
    this.bursts = this.bursts.filter((b) => t - b.t0 < BURST_LIFE);
    for (const b of this.bursts) {
      const k = (t - b.t0) / BURST_LIFE;
      const radius = 18 + k * 90;
      const alpha = 1 - k;
      const steps = 18;
      ctx.fillStyle = rgb(b.rgb, alpha);
      for (let j = 0; j < steps; j++) {
        const a = (j / steps) * Math.PI * 2 + k;
        const x = Math.round((b.x + Math.cos(a) * radius) / cw) * cw + cw / 2;
        const y = Math.round((b.y + Math.sin(a) * radius * 0.7) / ch) * ch + ch / 2;
        ctx.fillText(k < 0.4 ? "*" : "+", x, y + 1);
      }
      ctx.fillText(k < 0.5 ? "@" : "o", Math.round(b.x / cw) * cw + cw / 2, Math.round(b.y / ch) * ch + ch / 2 + 1);
    }
  }

  /** Small task label just ahead of each creature's head. */
  drawLabels(world) {
    const { ctx, ch } = this;
    ctx.font = `500 ${Math.max(10, Math.round(ch * 0.62))}px ${this.fontFamily}`;
    for (const sh of world.sharks) {
      if (!sh.label || sh.leaving) continue;
      const x = sh.nodes[0];
      const y = sh.nodes[1] - Math.max(ch * 1.6, sh.length * 0.12);
      const alpha = sh.highlight > 0 ? 1 : 0.75;
      const text = sh.highlight > 0 ? `[ ${sh.label} ]` : sh.label;
      ctx.fillStyle = sh.highlight > 0 ? rgb([255, 255, 255], alpha) : rgb(this.theme.label.rgb, alpha);
      ctx.fillText(text, x, y);
    }
  }
}
