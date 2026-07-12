// Performance harness for the single-scene renderer.
//
// Two layers:
//   1. PerfMonitor — passive, per-frame collector. Wraps Scene.draw to measure
//      CPU time and snapshot the renderer/cache counters. Accumulates frames
//      into a ring buffer and produces summary statistics on demand.
//   2. runFlight — active, deterministic camera driver. Pushes the camera
//      through a scripted itinerary (zoom-in, pan, zoom-out, dwell) while the
//      monitor records. Returns a single summary object suitable for
//      console.table / JSON snapshot diffing.
//
// The harness is intentionally engine-agnostic about *what* the scene draws:
// it relies only on the public Scene API plus the QuadRenderer.stats counters
// added in this PR. That keeps it cheap to keep in production builds.

import type { Scene } from './scene';

export interface FrameSample {
  /** ms since flight start. */
  t: number;
  /** CPU duration of scene.draw() in ms. */
  drawMs: number;
  drawCalls: number;
  coloredInstances: number;
  texturedInstances: number;
  texturedBatches: number;
  bytesUploaded: number;
  /** Currently resident tile entries (all statuses). */
  tileCacheSize: number;
  /** Currently resident GPU texture entries (text + image). */
  textureCacheSize: number;
  /** Camera state at draw time, for correlating spikes to position. */
  zoom: number;
  cx: number;
  cy: number;
}

export interface PerfSummary {
  frames: number;
  durationMs: number;
  fps: number;
  /** Wall-clock interval between consecutive recorded frames. */
  frameMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  /** scene.draw() CPU cost. */
  drawMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  drawCalls: { mean: number; max: number };
  coloredInstances: { mean: number; max: number };
  texturedInstances: { mean: number; max: number };
  texturedBatches: { mean: number; max: number };
  bytesUploaded: { mean: number; max: number };
  peakTileCache: number;
  peakTextureCache: number;
  /** Snapshot of the original ring buffer (truncated to last N samples). */
  samples: FrameSample[];
}

interface MonitorOptions {
  /** Maximum samples kept in the ring buffer. Default 4096. */
  capacity?: number;
}

export class PerfMonitor {
  private scene: Scene;
  private originalDraw: () => void;
  private samples: FrameSample[] = [];
  private capacity: number;
  private active = false;
  private startT = 0;

  constructor(scene: Scene, opts: MonitorOptions = {}) {
    this.scene = scene;
    this.capacity = opts.capacity ?? 4096;
    this.originalDraw = scene.draw.bind(scene);
    scene.draw = (): void => this.wrappedDraw();
  }

  /** Begin recording. Discards prior samples. */
  start(): void {
    this.samples.length = 0;
    this.active = true;
    this.startT = performance.now();
  }

  /** Stop recording. Samples remain available via `summary()`. */
  stop(): void {
    this.active = false;
  }

  /** Restore the original Scene.draw so further frames are uninstrumented. */
  detach(): void {
    this.active = false;
    this.scene.draw = this.originalDraw;
  }

  /** All collected samples (live reference; do not mutate). */
  getSamples(): readonly FrameSample[] {
    return this.samples;
  }

  /** Produce summary statistics over the currently buffered samples. */
  summary(): PerfSummary {
    return summarize(this.samples);
  }

  private wrappedDraw(): void {
    if (!this.active) {
      this.originalDraw();
      return;
    }
    const t0 = performance.now();
    this.originalDraw();
    const t1 = performance.now();

    if (this.samples.length >= this.capacity) {
      // Drop the oldest; keeps the harness bounded under long sessions.
      this.samples.shift();
    }
    const stats = this.scene.renderer.stats;
    const cam = this.scene.camera;
    this.samples.push({
      t: t1 - this.startT,
      drawMs: t1 - t0,
      drawCalls: stats.drawCalls,
      coloredInstances: stats.coloredInstances,
      texturedInstances: stats.texturedInstances,
      texturedBatches: stats.texturedBatches,
      bytesUploaded: stats.bytesUploaded,
      tileCacheSize: this.scene.cache.size(),
      textureCacheSize: this.scene.textures.size(),
      zoom: cam.zoom,
      cx: cam.centerX,
      cy: cam.centerY,
    });
  }
}

// --- Flight script ---------------------------------------------------------

export interface FlightStep {
  /** Label written into the summary (and console). */
  name: string;
  /** Target zoom at the end of this step. */
  zoom: number;
  /** Target world center at the end of this step (0..1 world space). */
  cx: number;
  cy: number;
  /** Step duration in milliseconds (real time). */
  durationMs: number;
}

export interface FlightOptions {
  /** Steps to execute in order. */
  steps: FlightStep[];
  /** If true, wait one rAF tick between forcing dirty + drawing. Default true. */
  yieldEachFrame?: boolean;
  /** Console log progress. Default true. */
  log?: boolean;
}

const DEFAULT_FLIGHT: FlightStep[] = [
  { name: 'rest@z0',      zoom: 0,  cx: 0.5,  cy: 0.5,  durationMs: 300 },
  { name: 'zoom→z4',      zoom: 4,  cx: 0.5,  cy: 0.5,  durationMs: 800 },
  { name: 'zoom→z8',      zoom: 8,  cx: 0.5,  cy: 0.5,  durationMs: 800 },
  { name: 'zoom→z12',     zoom: 12, cx: 0.5,  cy: 0.5,  durationMs: 800 },
  { name: 'zoom→z16',     zoom: 16, cx: 0.5,  cy: 0.5,  durationMs: 800 },
  { name: 'zoom→z20',     zoom: 20, cx: 0.5,  cy: 0.5,  durationMs: 800 },
  { name: 'pan@z20',      zoom: 20, cx: 0.48, cy: 0.52, durationMs: 600 },
  { name: 'zoom-out→z0',  zoom: 0,  cx: 0.5,  cy: 0.5,  durationMs: 1200 },
];

/**
 * Run a scripted camera flight and return summary stats. The function is async
 * and resolves only after the final dwell completes, so callers can `await`
 * it from a devtools console. The harness drives the camera directly (no
 * physics spring), so results are deterministic across runs at the same
 * canvas size.
 */
export async function runFlight(
  scene: Scene,
  options: Partial<FlightOptions> = {}
): Promise<PerfSummary> {
  const steps = options.steps ?? DEFAULT_FLIGHT;
  const log = options.log ?? true;
  const monitor = new PerfMonitor(scene);
  monitor.start();

  const cam = scene.camera;
  // Capture and override interactive state so user input/inertia can't perturb
  // the flight. Restored at the end.
  const saved = {
    cx: cam.centerX, cy: cam.centerY,
    zoom: cam.zoom, zoomTarget: cam.zoomTarget,
    velX: cam.velX, velY: cam.velY, zoomVel: cam.zoomVel,
  };
  cam.velX = 0; cam.velY = 0; cam.zoomVel = 0;

  try {
    let prev = { zoom: cam.zoom, cx: cam.centerX, cy: cam.centerY };
    for (const step of steps) {
      if (log) console.log('[perf]', step.name, '→', step);
      const t0 = performance.now();
      const dur = Math.max(1, step.durationMs);
      // Drive every rAF tick until step duration elapses.
      while (true) {
        const now = performance.now();
        const u = Math.min(1, (now - t0) / dur);
        const e = easeInOut(u);
        cam.zoom = prev.zoom + (step.zoom - prev.zoom) * e;
        cam.zoomTarget = step.zoom;
        cam.centerX = prev.cx + (step.cx - prev.cx) * e;
        cam.centerY = prev.cy + (step.cy - prev.cy) * e;
        scene.markDirty();
        scene.refreshTileRequests();
        scene.draw();
        await rafTick();
        if (u >= 1) break;
      }
      prev = { zoom: step.zoom, cx: step.cx, cy: step.cy };
    }
  } finally {
    cam.centerX = saved.cx; cam.centerY = saved.cy;
    cam.zoom = saved.zoom; cam.zoomTarget = saved.zoomTarget;
    cam.velX = saved.velX; cam.velY = saved.velY; cam.zoomVel = saved.zoomVel;
    monitor.stop();
    monitor.detach();
  }

  const summary = monitor.summary();
  if (log) {
    console.log('[perf] summary', summary);
    console.table({
      fps: round(summary.fps, 1),
      frames: summary.frames,
      drawMs_mean: round(summary.drawMs.mean, 2),
      drawMs_p95:  round(summary.drawMs.p95, 2),
      drawMs_p99:  round(summary.drawMs.p99, 2),
      drawMs_max:  round(summary.drawMs.max, 2),
      drawCalls_max: summary.drawCalls.max,
      colored_max: summary.coloredInstances.max,
      textured_max: summary.texturedInstances.max,
      texBatches_max: summary.texturedBatches.max,
      peakTextureCache: summary.peakTextureCache,
      peakTileCache: summary.peakTileCache,
    });
  }
  return summary;
}

function easeInOut(u: number): number {
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
}

function rafTick(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// --- Summarization ---------------------------------------------------------

function summarize(samples: FrameSample[]): PerfSummary {
  const n = samples.length;
  if (n === 0) {
    return emptySummary();
  }
  const drawMs = samples.map((s) => s.drawMs);
  const frameMs: number[] = [];
  for (let i = 1; i < n; i++) frameMs.push(samples[i].t - samples[i - 1].t);
  // Pad with one entry to keep the array non-empty when n === 1.
  if (frameMs.length === 0) frameMs.push(samples[0].t || 16.67);

  const durationMs = samples[n - 1].t - samples[0].t || 1;
  const fps = (n - 1) / (durationMs / 1000);

  return {
    frames: n,
    durationMs,
    fps,
    frameMs: stats(frameMs),
    drawMs: stats(drawMs),
    drawCalls: meanMax(samples.map((s) => s.drawCalls)),
    coloredInstances: meanMax(samples.map((s) => s.coloredInstances)),
    texturedInstances: meanMax(samples.map((s) => s.texturedInstances)),
    texturedBatches: meanMax(samples.map((s) => s.texturedBatches)),
    bytesUploaded: meanMax(samples.map((s) => s.bytesUploaded)),
    peakTileCache: Math.max(...samples.map((s) => s.tileCacheSize)),
    peakTextureCache: Math.max(...samples.map((s) => s.textureCacheSize)),
    samples: samples.slice(-512),
  };
}

function stats(values: number[]): PerfSummary['drawMs'] {
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function meanMax(values: number[]): { mean: number; max: number } {
  if (values.length === 0) return { mean: 0, max: 0 };
  let sum = 0;
  let max = -Infinity;
  for (const v of values) { sum += v; if (v > max) max = v; }
  return { mean: sum / values.length, max };
}

function round(v: number, digits: number): number {
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
}

function emptySummary(): PerfSummary {
  const z = { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    frames: 0,
    durationMs: 0,
    fps: 0,
    frameMs: z,
    drawMs: z,
    drawCalls: { mean: 0, max: 0 },
    coloredInstances: { mean: 0, max: 0 },
    texturedInstances: { mean: 0, max: 0 },
    texturedBatches: { mean: 0, max: 0 },
    bytesUploaded: { mean: 0, max: 0 },
    peakTileCache: 0,
    peakTextureCache: 0,
    samples: [],
  };
}

// --- Adaptive Quality Manager -----------------------------------------------

export interface AdaptiveQualityOptions {
  targetFps?: number;
  minCacheCapacity?: number;
  maxCacheCapacity?: number;
  windowSize?: number;
}

/**
 * Monitors frame draw times and adjusts the tile cache capacity to maintain
 * a target frame rate. When frames are consistently slow, the cache shrinks
 * (reducing memory + tile generation work). When frames are fast, the cache
 * grows back to improve visual coverage.
 */
export class AdaptiveQuality {
  private scene: Scene;
  private drawTimes: number[] = [];
  private readonly window: number;
  private readonly budgetMs: number;
  private readonly minCap: number;
  private readonly maxCap: number;

  constructor(scene: Scene, opts: AdaptiveQualityOptions = {}) {
    this.scene = scene;
    const targetFps = opts.targetFps ?? 60;
    this.budgetMs = (1000 / targetFps) * 0.75;  // 75% of frame budget as threshold
    this.minCap = opts.minCacheCapacity ?? 512;
    this.maxCap = opts.maxCacheCapacity ?? 4096;
    this.window = opts.windowSize ?? 10;
  }

  /** Call once per frame with the CPU draw time in ms. */
  update(drawMs: number): void {
    this.drawTimes.push(drawMs);
    if (this.drawTimes.length > this.window) this.drawTimes.shift();
    if (this.drawTimes.length < 3) return;

    let sum = 0;
    for (let i = 0; i < this.drawTimes.length; i++) sum += this.drawTimes[i];
    const avg = sum / this.drawTimes.length;

    const cap = this.scene.cache.getCapacity();
    if (avg > this.budgetMs && cap > this.minCap) {
      this.scene.cache.setCapacity(Math.max(this.minCap, Math.round(cap * 0.9)));
    } else if (avg < this.budgetMs * 0.6 && cap < this.maxCap) {
      this.scene.cache.setCapacity(Math.min(this.maxCap, Math.round(cap * 1.1)));
    }
  }
}
