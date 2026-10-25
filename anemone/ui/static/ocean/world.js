// Ported from ascii-sharks (MIT, (c) 2026 drewdi) — see ./LICENSE.
// Changes for anemone: creatures are driven by live data (sync()), they swim in when a
// task starts and out when it ends, their size and drive follow the task, and some prey
// can be tagged (queued tasks). All looks come from the theme.
/**
 * Artificial-life sim: tiny prey schools and the creatures that hunt them.
 *
 * Prey: Reynolds boids (separation / alignment / cohesion) in Couzin-style zones, with a
 * blind spot behind each one. Alarm spreads through the school (a "wave of agitation"),
 * so a whole school bolts even when only its edge can see the hunter. Fleeing prey break
 * sideways around the hunter's path, which gives the fountain effect seen in bait balls.
 *
 * Creatures: Reynolds steering (wander + pursuit + separation) on a follow-the-leader
 * spine. Hunger builds over time and drops when they eat. They prefer prey in sparse
 * spots, so stragglers get picked off. Eaten prey come back later as new schools.
 */
import { angleDiff, clamp, current, rand, randInt, TAU } from "./math.js";

export const NODES = 20;

const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible
const BAIT_MAX = 60;
const BAIT_LIFE = 30; // seconds before an uneaten pellet dissolves
const BAIT_SINK = 9; // px/s

export class World {
  constructor(theme, { fishCount } = {}) {
    this.width = 0;
    this.height = 0;
    this.time = 0;
    this.fish = [];
    this.creatures = [];
    this.bait = [];
    this.baitLife = BAIT_LIFE;
    this.events = [];
    this.pointer = { x: 0, y: 0, active: false };
    this.queued = 0;
    this.fishCount = fishCount;
    this.nextId = 1;
    this.perception = 60;
    this.sepX = [];
    this.sepY = [];
    this.foreignSep = 40;
    this.bucketCols = 0;
    this.bucketRows = 0;
    this.bucketHead = new Int32Array(0);
    this.bucketCount = new Uint16Array(0);
    this.bucketNext = new Int32Array(0);
    this.lastSpawn = 0;
    this.tmp = { x: 0, y: 0 };
    this.cellW = 12;
    this.cellH = 18;
    this.setTheme(theme);
  }

  setTheme(theme) {
    this.theme = theme;
    this.species = theme.species;
    this.totalWeight = this.species.reduce((sum, s) => sum + s.weight, 0);
    if (this.width) {
      this.resize(this.width, this.height, this.cellW, this.cellH);
      this.seedFish();
    }
  }

  pickSpecies() {
    let r = Math.random() * this.totalWeight;
    for (let i = 0; i < this.species.length; i++) {
      r -= this.species[i].weight;
      if (r <= 0) return i;
    }
    return 0;
  }

  resize(width, height, cellW, cellH) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    this.cellW = cellW;
    this.cellH = cellH;
    this.sepX = this.species.map((sp) => sp.spacing[0] * cellW);
    this.sepY = this.species.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;
    // Reseed when the window changes size a lot, so the prey count fits the screen.
    const target = this.fishCount ?? clamp(Math.round((width * height) / 4400), 85, 340);
    if (first || this.fish.length === 0 || this.fish.length > target * 1.3 || this.fish.length < target * 0.7) {
      this.seedFish();
      return;
    }
    for (const f of this.fish) {
      f.x = clamp(f.x, 0, width);
      f.y = clamp(f.y, 0, height);
    }
  }

  seedFish() {
    const { width: W, height: H } = this;
    const total = this.fishCount ?? clamp(Math.round((W * H) / 4400), 85, 340);
    this.fish = [];
    while (this.fish.length < total) {
      const species = this.pickSpecies();
      const sp = this.species[species];
      const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
      const millDir = Math.random() < 0.5 ? 1 : -1;
      const cx = rand(W * 0.06, W * 0.94);
      const cy = rand(H * 0.08, H * 0.92);
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      for (let k = 0; k < size; k++) {
        this.fish.push({
          x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species, alarm: 0, alive: true, respawnAt: 0,
          phase: rand(0, TAU), turn: 0, depth: rand(0.55, 1), millDir, tagged: false,
        });
      }
    }
    this.bucketNext = new Int32Array(this.fish.length);
  }

  // ── live data ───────────────────────────────────────────────────────

  /** Base creature length for this screen, shrunk when many share the water. */
  lengthFor(size, count) {
    const base = clamp(Math.min(this.width, this.height) * 0.44, 170, 430);
    const crowd = clamp(Math.sqrt(3 / Math.max(count, 1)), 0.42, 1);
    return base * size * crowd;
  }

  /**
   * Make the creatures match `specs` ([{id, kind, size 0..1, activity 0..1.5, label}]).
   * New ids swim in from an edge; ids that disappeared swim away, with a burst coloured
   * by `finished[id]` (an [r, g, b] for how the task ended).
   */
  sync(specs, finished = {}) {
    if (!this.width) return;
    const byId = new Map(this.creatures.map((s) => [s.taskId, s]));
    const live = new Set();
    for (const sp of specs) {
      live.add(sp.id);
      let sh = byId.get(sp.id);
      if (!sh || sh.leaving) sh = this.spawn(sp, specs.length);
      sh.targetLength = this.lengthFor(sp.size, specs.length);
      sh.kind = sp.kind;
      sh.activity = sp.activity;
      sh.label = sp.label;
      sh.depth = 0.55 + 0.45 * clamp(sp.size, 0, 1);
    }
    for (const sh of this.creatures) {
      if (!live.has(sh.taskId) && !sh.leaving) this.release(sh, finished[sh.taskId]);
    }
    // Smaller (farther) creatures draw first so big ones swim over them.
    this.creatures.sort((a, b) => a.targetLength - b.targetLength);
  }

  spawn(spec, count) {
    const { width: W, height: H } = this;
    const length = this.lengthFor(spec.size, count);
    const side = randInt(0, 3);
    const along = rand(0.15, 0.85);
    const x = side === 0 ? -30 : side === 1 ? W + 30 : along * W;
    const y = side === 2 ? -30 : side === 3 ? H + 30 : along * H;
    const heading = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.45, 0.45);
    const nodes = new Float32Array(NODES * 2);
    const seg = length / (NODES - 1);
    for (let n = 0; n < NODES; n++) {
      nodes[n * 2] = x - Math.cos(heading) * seg * n;
      nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
    }
    const minSide = Math.min(W, H);
    const sh = {
      id: this.nextId++,
      taskId: spec.id,
      kind: spec.kind,
      label: spec.label,
      length, targetLength: length, nodes, heading,
      speed: 40, phase: rand(0, TAU), turn: 0,
      hunger: rand(0.3, 0.7), wander: 0,
      orbitDir: Math.random() < 0.5 ? 1 : -1,
      orbitRadius: minSide * rand(0.22, 0.4),
      target: null, retargetAt: 0,
      depth: 0.55 + 0.45 * clamp(spec.size, 0, 1),
      activity: spec.activity ?? 0.5,
      leaving: false, leaveAt: 0, highlight: 0,
    };
    this.creatures.push(sh);
    return sh;
  }

  release(sh, rgb) {
    sh.leaving = true;
    sh.leaveAt = this.time;
    sh.target = null;
    if (rgb) this.events.push({ kind: "burst", x: sh.nodes[0], y: sh.nodes[1], rgb });
  }

  /** Flash a creature's label briefly (the dashboard calls this when you click a task). */
  highlight(taskId) {
    for (const sh of this.creatures) if (sh.taskId === taskId) sh.highlight = 2.5;
  }

  creatureAt(x, y, radius = 70) {
    let best = null;
    let bestD = radius;
    for (const sh of this.creatures) {
      if (sh.leaving) continue;
      for (let k = 0; k < NODES; k += 3) {
        const d = Math.hypot(sh.nodes[k * 2] - x, sh.nodes[k * 2 + 1] - y);
        if (d < bestD) {
          bestD = d;
          best = sh;
        }
      }
    }
    return best;
  }

  splash(x, y) {
    this.events.push({ kind: "splash", x, y });
    const r = 240;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      const k = (1 - d / r) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
  }

  /** Drop a pinch of food at (x, y): a few pellets that sink slowly until eaten or gone. */
  dropBait(x, y) {
    this.events.push({ kind: "splash", x, y });
    for (let i = 0; i < 5; i++) {
      this.bait.push({ x: x + rand(-16, 16), y: y + rand(-10, 10), vx: rand(-10, 10), vy: rand(2, 8), born: this.time, alive: true });
    }
    if (this.bait.length > BAIT_MAX) this.bait.splice(0, this.bait.length - BAIT_MAX);
  }

  stepBait(dt) {
    const drag = Math.exp(-dt * 1.5);
    for (const b of this.bait) {
      b.vx *= drag;
      b.vy += (BAIT_SINK - b.vy) * Math.min(1, dt * 0.8);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (this.time - b.born > this.baitLife || b.y > this.height + 10) b.alive = false;
    }
    this.bait = this.bait.filter((b) => b.alive);
  }

  nearestBait(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.bait) {
      const d = (b.x - x) ** 2 + (b.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  step(dt) {
    this.time += dt;
    this.rebuildHash();
    this.stepFish(dt);
    this.stepBait(dt);
    this.stepCreatures(dt);
    this.respawn();
    this.tagQueued();
  }

  /** The first N living prey glow as queued tasks. */
  tagQueued() {
    let left = this.queued;
    for (const f of this.fish) {
      f.tagged = f.alive && left > 0;
      if (f.tagged) left--;
    }
  }

  rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.fish.length) this.bucketNext = new Int32Array(this.fish.length);
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      if (!f.alive) continue;
      const b = this.bucketOf(f.x, f.y);
      this.bucketNext[i] = this.bucketHead[b];
      this.bucketHead[b] = i;
      this.bucketCount[b]++;
    }
  }

  bucketOf(x, y) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  stepFish(dt) {
    const { fish, creatures, pointer, width: W, height: H, time, species } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const cur = this.tmp;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const sp = species[f.species];
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species] * spread;
      const sepY = this.sepY[f.species] * spread;
      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0, ay = 0, sx = 0, sy = 0, avx = 0, avy = 0, cx = 0, cy = 0, n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c];
          while (j !== -1) {
            if (j !== i) {
              const o = fish[j];
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx; avy += o.vy; cx += dx; cy += dy; n++;
                  } else if (d < foreignSep) {
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j];
          }
        }
      }

      ax += sx * FISH_SEPARATION_K;
      ay += sy * FISH_SEPARATION_K;
      if (n > 0) {
        const alignK = FISH_ALIGN_K * sp.align;
        const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Predators: distance to the nearest point along the front half of each creature.
      let fear = 0;
      for (const sh of creatures) {
        const fearR = sh.length * 0.6 + 60;
        let best = Infinity, bx = 0, by = 0;
        for (let k = 0; k <= 12; k += 3) {
          const nx = sh.nodes[k * 2];
          const ny = sh.nodes[k * 2 + 1];
          const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
          if (d2 < best) { best = d2; bx = nx; by = ny; }
        }
        const d = Math.sqrt(best);
        if (d >= fearR || d < 1e-3) continue;
        let w = 1 - d / fearR;
        w *= w;
        const awayX = (f.x - bx) / d;
        const awayY = (f.y - by) / d;
        const shx = Math.cos(sh.heading);
        const shy = Math.sin(sh.heading);
        const side = shx * (f.y - sh.nodes[1]) - shy * (f.x - sh.nodes[0]) >= 0 ? 1 : -1;
        ax += (awayX * 0.7 - shy * side * 0.9) * FISH_FLEE_K * w;
        ay += (awayY * 0.7 + shx * side * 0.9) * FISH_FLEE_K * w;
        fear = Math.max(fear, Math.sqrt(w));
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * FISH_FLEE_K * w;
          ay += (dy / d) * FISH_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > H - m) ay -= (f.y - (H - m)) * 7;

      current(f.x, f.y, time, cur);
      ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);

      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  stepCreatures(dt) {
    const { creatures, width: W, height: H, time } = this;
    const minSide = Math.min(W, H);
    const cxW = W / 2;
    const cyW = H / 2;

    for (const sh of creatures) {
      sh.length += (sh.targetLength - sh.length) * Math.min(1, dt * 0.8);
      sh.highlight = Math.max(0, sh.highlight - dt);
      const L = sh.length;
      const nodes = sh.nodes;
      const hx = nodes[0];
      const hy = nodes[1];
      // Busy tasks hunt harder and swim faster.
      const drive = clamp(sh.activity, 0, 1.5);
      sh.hunger = Math.min(1, Math.max(sh.hunger + dt * 0.03, drive * 0.6));

      let dx = Math.cos(sh.heading);
      let dy = Math.sin(sh.heading);

      sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1);
      dx += Math.cos(sh.heading + sh.wander) * 0.45;
      dy += Math.sin(sh.heading + sh.wander) * 0.45;

      let hunting = false;
      let feeding = false;
      let closing = 0;
      const food = sh.leaving ? null : this.nearestBait(hx, hy);
      if (food) {
        // Food beats prey: head straight for the nearest pellet.
        const tx = food.x - hx;
        const ty = food.y - hy;
        const d = Math.hypot(tx, ty) || 1;
        dx += (tx / d) * 4;
        dy += (ty / d) * 4;
        feeding = true;
        closing = clamp(1 - d / (L * 0.9), 0, 1);
      } else if (sh.leaving) {
        // Done: swim straight off the nearest edge.
        const ex = hx < cxW ? -1 : 1;
        const ey = hy < cyW ? -1 : 1;
        const tx = Math.abs(hx - cxW) / W > Math.abs(hy - cyW) / H ? ex : 0;
        const ty = tx === 0 ? ey : 0;
        dx += tx * 3;
        dy += ty * 3;
      } else {
        if (time >= sh.retargetAt) {
          sh.target = this.findPrey(sh);
          sh.retargetAt = time + 0.45;
        }
        const t = sh.target;
        if (t && t.alive && sh.hunger > 0.3) {
          const tx = t.x + t.vx * 0.35 - hx;
          const ty = t.y + t.vy * 0.35 - hy;
          const d = Math.hypot(tx, ty) || 1;
          const w = 1.4 + 2.6 * sh.hunger;
          dx += (tx / d) * w;
          dy += (ty / d) * w;
          hunting = true;
          closing = clamp(1 - d / (L * 0.9), 0, 1);
        } else {
          const rx = (hx - cxW) / (W / minSide);
          const ry = hy - cyW;
          const r = Math.hypot(rx, ry) || 1;
          const radius = sh.orbitRadius * (1 + 0.15 * Math.sin(time * 0.05 + sh.id));
          const radial = clamp((radius - r) / radius, -1, 1);
          dx += ((-ry / r) * sh.orbitDir + (rx / r) * radial * 0.9) * 0.55;
          dy += ((rx / r) * sh.orbitDir + (ry / r) * radial * 0.9) * 0.55;
        }
      }

      for (const other of creatures) {
        if (other === sh) continue;
        for (let k = 0; k < NODES; k += 4) {
          const ox = hx - other.nodes[k * 2];
          const oy = hy - other.nodes[k * 2 + 1];
          const d = Math.hypot(ox, oy);
          const range = (L + other.length) * 0.45;
          if (d < range && d > 1e-3) {
            const w = (1 - d / range) * 3;
            dx += (ox / d) * w;
            dy += (oy / d) * w;
          }
        }
      }

      if (!sh.leaving) {
        // Turn back once the head leaves the frame, so bodies dip off-screen now and
        // then but never wander away; this also pulls newly spawned creatures in.
        const over = Math.max(-hx, hx - W, -hy, hy - H);
        if (over > -L * 0.05) {
          const w = clamp((over + L * 0.05) / (L * 0.35), 0, 1) * 3.5;
          const toX = cxW - hx;
          const toY = cyW - hy;
          const d = Math.hypot(toX, toY) || 1;
          dx += (toX / d) * w;
          dy += (toY / d) * w;
        }
      }

      const desired = Math.atan2(dy, dx);
      const agility = Math.min(feeding ? 2.4 + closing : hunting ? 1.7 + closing : sh.leaving ? 1.4 : 0.8, sh.speed / (L * 0.22));
      const maxTurn = agility * dt;
      const turned = clamp(angleDiff(sh.heading, desired), -maxTurn, maxTurn);
      sh.heading += turned;
      sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);

      const cruise = (30 + L * 0.04) * (0.7 + 0.5 * drive);
      // Slow down near food so the turn is tight enough to reach it instead of circling.
      const targetSpeed = sh.leaving ? cruise * 1.8 : feeding ? cruise * (1.6 - closing * 0.9) : hunting ? cruise * (1.45 + closing * 1.5) : cruise;
      sh.speed += (targetSpeed - sh.speed) * Math.min(1, dt * 1.1);
      sh.phase += dt * (2 + sh.speed / 24);

      nodes[0] += Math.cos(sh.heading) * sh.speed * dt;
      nodes[1] += Math.sin(sh.heading) * sh.speed * dt;

      // Follow-the-leader spine with a stiffness limit per joint.
      const seg = L / (NODES - 1);
      const maxBend = 0.16;
      let prevAngle = sh.heading + Math.PI;
      for (let k = 1; k < NODES; k++) {
        const px = nodes[(k - 1) * 2];
        const py = nodes[(k - 1) * 2 + 1];
        let angle = Math.atan2(nodes[k * 2 + 1] - py, nodes[k * 2] - px);
        angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
        nodes[k * 2] = px + Math.cos(angle) * seg;
        nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
        prevAngle = angle;
      }

      if (feeding) {
        const mouthR = L * 0.06 + 10;
        for (const b of this.bait) {
          if (b.alive && (b.x - nodes[0]) ** 2 + (b.y - nodes[1]) ** 2 < mouthR * mouthR) {
            b.alive = false;
            sh.eaten = (sh.eaten ?? 0) + 1;
            this.events.push({ kind: "eat", x: b.x, y: b.y });
          }
        }
      }

      if (!sh.leaving && sh.hunger > 0.15) {
        const mouthR = L * 0.05 + 8;
        const mx = nodes[0];
        const my = nodes[1];
        for (const f of this.fish) {
          if (!f.alive) continue;
          if ((f.x - mx) ** 2 + (f.y - my) ** 2 < mouthR * mouthR) {
            f.alive = false;
            f.respawnAt = time + rand(3, 8);
            sh.hunger = Math.max(0, sh.hunger - 0.16);
            this.events.push({ kind: "eat", x: f.x, y: f.y });
          }
        }
      }
    }

    // Drop creatures that have left the screen.
    this.creatures = creatures.filter((sh) => {
      if (!sh.leaving) return true;
      const margin = sh.length * 1.05;
      const tailX = sh.nodes[(NODES - 1) * 2];
      const tailY = sh.nodes[(NODES - 1) * 2 + 1];
      const gone = (x, y) => x < -margin * 0.2 || x > W + margin * 0.2 || y < -margin * 0.2 || y > H + margin * 0.2;
      return !(gone(sh.nodes[0], sh.nodes[1]) && gone(tailX, tailY)) && time - sh.leaveAt < 20;
    });
  }

  findPrey(sh) {
    const range = sh.length * 0.9 + 160;
    const hx = sh.nodes[0];
    const hy = sh.nodes[1];
    const fx = Math.cos(sh.heading);
    const fy = Math.sin(sh.heading);
    let best = null;
    let bestScore = Infinity;
    let currentScore = Infinity;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - hx;
      const dy = f.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const cos = (dx * fx + dy * fy) / d;
      if (cos < 0.2) continue;
      const crowd = this.bucketCount[this.bucketOf(f.x, f.y)];
      const score = d * (1 + (1 - cos) * 0.8) * (1 + crowd * 0.07);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
      if (f === sh.target) currentScore = score;
    }
    if (sh.target && currentScore < bestScore * 1.3) return sh.target;
    return best;
  }

  respawn() {
    const { time, width: W, height: H } = this;
    const due = [];
    for (const f of this.fish) if (!f.alive && f.respawnAt <= time) due.push(f);
    if (due.length === 0) return;
    if (due.length < 6 && time - this.lastSpawn < 9) return;
    this.lastSpawn = time;
    const side = randInt(0, 3);
    const along = rand(0.15, 0.85);
    const x = side === 0 ? -20 : side === 1 ? W + 20 : along * W;
    const y = side === 2 ? -20 : side === 3 ? H + 20 : along * H;
    const inward = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.5, 0.5);
    const species = this.pickSpecies();
    const sp = this.species[species];
    const millDir = Math.random() < 0.5 ? 1 : -1;
    for (const f of due.slice(0, sp.schoolSize[1])) {
      f.alive = true;
      f.species = species;
      f.alarm = 0;
      f.turn = 0;
      f.millDir = millDir;
      f.x = x + rand(-1, 1) * this.perception;
      f.y = y + rand(-1, 1) * this.perception;
      f.vx = Math.cos(inward) * sp.cruise * 1.4;
      f.vy = Math.sin(inward) * sp.cruise * 1.4;
    }
  }
}
