// Ported from ascii-sharks (MIT, (c) 2026 drewdi) — see ./LICENSE.
// Changes for agentbox: takes a theme (swappable at runtime) and exposes the world so the
// dashboard can feed it live data.
import { AsciiRenderer } from "./renderer.js";
import { World } from "./world.js";

const STEP = 1 / 60;
const MAX_STEPS = 4;
// Draw at most this often. 60 fps looks the same as 144 and uses far less CPU.
const MIN_FRAME_MS = 1000 / 60 - 1.5;

/**
 * Wires World + AsciiRenderer to a canvas: fixed-timestep loop, resize, pointer input,
 * pausing off-screen, and prefers-reduced-motion.
 */
export class OceanEngine {
  /** options.pointerTarget: element whose pointer events move the prey (default: the canvas). */
  constructor(canvas, theme, options = {}) {
    this.canvas = canvas;
    this.pointerTarget = options.pointerTarget ?? canvas;
    this.world = new World(theme);
    this.renderer = new AsciiRenderer(canvas, theme);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.raf = 0;
    this.last = 0;
    this.acc = 0;
    this.visible = true;
    this.disposed = false;
    /** Set true to animate even when the OS asks for reduced motion. */
    this.ignoreReducedMotion = false;

    this.frame = this.frame.bind(this);
    this.onMotionPreference = this.onMotionPreference.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", () => this.schedule());

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    this.pointerTarget.addEventListener("pointermove", this.onPointerMove, { passive: true });
    this.pointerTarget.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    this.pointerTarget.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);

    this.resize();
    document.fonts?.load(`600 16px ${this.renderer.fontFamily}`).then(() => {
      if (!this.disposed && this.stillMode) this.drawStill();
    });
    this.schedule();
  }

  setTheme(theme) {
    this.world.setTheme(theme);
    this.renderer.setTheme(theme);
    if (this.stillMode) this.drawStill();
  }

  /** True when we should show still frames instead of animating. */
  get stillMode() {
    return this.reducedMotion.matches && !this.ignoreReducedMotion;
  }

  setIgnoreReducedMotion(on) {
    this.ignoreReducedMotion = on;
    this.onMotionPreference();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    this.pointerTarget.removeEventListener("pointermove", this.onPointerMove);
    this.pointerTarget.removeEventListener("pointerdown", this.onPointerDown);
    this.pointerTarget.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.world.resize(rect.width, rect.height, this.renderer.cellWidth, this.renderer.cellHeight);
    if (this.stillMode) this.drawStill();
  }

  schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || document.hidden || this.stillMode) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  frame(now) {
    if (now - this.last < MIN_FRAME_MS) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.world.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.renderer.render(this.world, dt);
    this.frames = (this.frames ?? 0) + 1;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Reduced motion: let the scene settle, then redraw a single frame (called on every data update). */
  drawStill() {
    if (this.world.time < 4) for (let i = 0; i < 240; i++) this.world.step(STEP);
    else for (let i = 0; i < 30; i++) this.world.step(STEP);
    this.renderer.render(this.world, STEP);
  }

  onMotionPreference() {
    if (this.stillMode) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  }

  toLocal(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
  }

  onPointerMove(e) {
    const { x, y, inside } = this.toLocal(e);
    const p = this.world.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch";
  }

  onPointerDown(e) {
    const { x, y, inside } = this.toLocal(e);
    if (inside && !this.stillMode) this.world.splash(x, y);
  }

  onPointerLeave() {
    this.world.pointer.active = false;
  }
}
