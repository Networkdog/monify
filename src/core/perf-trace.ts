// ---------------------------------------------------------------------------
// PerfTrace — zero-cost performance tracing for Playwright-driven analysis.
//
// Design:
//   - All tracing is gated by a single `enabled` boolean checked at each
//     call site. When disabled (production default), every function is a
//     no-op that the JIT can inline away — zero overhead.
//   - When enabled (via `PerfTrace.enable()` or `?perf-trace` query param),
//     records per-frame timing breakdowns, FPS drops, tile generation costs,
//     and camera state into a ring buffer.
//   - Collected data is exposed on `window.__PERF_TRACE__` for Playwright
//     to `page.evaluate()` and extract.
//
// Usage from devtools / Playwright:
//   PerfTrace.enable();          // start recording
//   // ... interact with scene ...
//   const data = PerfTrace.flush();   // get + clear buffer
//   PerfTrace.disable();         // stop recording
//
// Usage from Playwright test:
//   await page.evaluate(() => window.__PERF_TRACE__.enable());
//   // ... drive camera ...
//   const trace = await page.evaluate(() => window.__PERF_TRACE__.flush());
// ---------------------------------------------------------------------------

/** Single frame timing record. */
export interface TraceFrame {
  /** Monotonic frame index since enable(). */
  frame: number;
  /** performance.now() timestamp. */
  ts: number;
  /** Wall-clock delta from previous frame (ms). */
  dt: number;
  /** Instantaneous FPS (1000/dt). */
  fps: number;

  // --- Phase timings (ms) ---
  /** Camera.update() time. */
  cameraMs: number;
  /** refreshTileRequests() time. */
  tileReqMs: number;
  /** scene.draw() time. */
  drawMs: number;
  /** Total frame time (camera + tileReq + draw + overhead). */
  totalMs: number;

  // --- Rendering stats ---
  drawCalls: number;
  coloredInstances: number;
  texturedInstances: number;
  bytesUploaded: number;

  // --- Cache stats ---
  tileCacheSize: number;
  tileCacheHits: number;
  tileCacheMisses: number;
  textureCacheSize: number;

  // --- Camera state ---
  zoom: number;
  zoomTarget: number;
  centerX: number;
  centerY: number;

  // --- Tile generation ---
  /** Number of tiles generated this frame (via tileSource). */
  tilesGenerated: number;
  /** Total time spent in tileSource() this frame (ms). */
  tileGenMs: number;

  // --- Flags ---
  /** True if this frame was a FPS drop (fps < threshold). */
  drop: boolean;
  /** Reason for the drop if identified. */
  dropReason?: string;
}

/** Summary of a trace session. */
export interface TraceSummary {
  totalFrames: number;
  durationMs: number;
  avgFps: number;
  minFps: number;
  /** Frames where fps < dropThreshold. */
  drops: number;
  dropFrames: TraceFrame[];
  /** Percentile breakdown of frame times. */
  frameTimes: { p50: number; p90: number; p95: number; p99: number; max: number };
  /** Percentile breakdown of draw times. */
  drawTimes: { p50: number; p90: number; p95: number; p99: number; max: number };
  /** Top N slowest frames. */
  slowest: TraceFrame[];
  /** Zoom ranges where drops cluster. */
  dropZones: { zoomMin: number; zoomMax: number; count: number }[];
}

const RING_CAPACITY = 8192;
const DROP_FPS_THRESHOLD = 30;
const SLOWEST_COUNT = 20;

class PerfTraceImpl {
  enabled = false;

  private _ring: TraceFrame[] = [];
  private _frameIdx = 0;
  private _lastTs = 0;
  private _dropThreshold = DROP_FPS_THRESHOLD;

  // Per-frame accumulators (set by instrumentation points, read at end of frame)
  private _cameraMs = 0;
  private _tileReqMs = 0;
  private _drawMs = 0;
  private _tilesGenerated = 0;
  private _tileGenMs = 0;
  private _tileCacheHits = 0;
  private _tileCacheMisses = 0;

  /** Enable tracing. Clears any existing data. */
  enable(opts?: { dropThreshold?: number; capacity?: number }): void {
    this.enabled = true;
    this._ring.length = 0;
    this._frameIdx = 0;
    this._lastTs = performance.now();
    this._dropThreshold = opts?.dropThreshold ?? DROP_FPS_THRESHOLD;
  }

  /** Disable tracing. Data remains available via flush(). */
  disable(): void {
    this.enabled = false;
  }

  // ─── Instrumentation points (called from hot path) ─────────────────────

  /** Mark start of camera update. Returns timestamp for endCamera(). */
  beginCamera(): number {
    return performance.now();
  }

  /** Mark end of camera update. */
  endCamera(t0: number): void {
    this._cameraMs = performance.now() - t0;
  }

  /** Mark start of tile request phase. */
  beginTileReq(): number {
    return performance.now();
  }

  /** Mark end of tile request phase. */
  endTileReq(t0: number): void {
    this._tileReqMs = performance.now() - t0;
  }

  /** Mark start of draw phase. */
  beginDraw(): number {
    return performance.now();
  }

  /** Mark end of draw phase. */
  endDraw(t0: number): void {
    this._drawMs = performance.now() - t0;
  }

  /** Called when tileSource() generates a tile. */
  tileGenerated(genMs: number): void {
    this._tilesGenerated++;
    this._tileGenMs += genMs;
  }

  /** Called on tile cache hit. */
  tileCacheHit(): void {
    this._tileCacheHits++;
  }

  /** Called on tile cache miss. */
  tileCacheMiss(): void {
    this._tileCacheMisses++;
  }

  // ─── Frame commit ──────────────────────────────────────────────────────

  /**
   * Commit the current frame's data to the ring buffer.
   * Call once at the end of each frame, after draw + HUD.
   */
  commitFrame(scene: {
    renderer: { stats: { drawCalls: number; coloredInstances: number; texturedInstances: number; bytesUploaded: number } };
    cache: { size(): number };
    textures: { size(): number };
    camera: { zoom: number; zoomTarget: number; centerX: number; centerY: number };
  }): void {
    const now = performance.now();
    const dt = now - this._lastTs;
    const fps = dt > 0 ? 1000 / dt : 0;
    this._lastTs = now;

    const totalMs = this._cameraMs + this._tileReqMs + this._drawMs;
    const isDrop = fps < this._dropThreshold && this._frameIdx > 2; // skip first 2 frames

    let dropReason: string | undefined;
    if (isDrop) {
      if (this._tileGenMs > totalMs * 0.5) dropReason = 'tile-generation';
      else if (this._drawMs > totalMs * 0.7) dropReason = 'draw';
      else if (this._tileReqMs > totalMs * 0.3) dropReason = 'tile-requests';
      else if (this._cameraMs > 2) dropReason = 'camera-update';
      else dropReason = 'unknown';
    }

    const frame: TraceFrame = {
      frame: this._frameIdx++,
      ts: now,
      dt,
      fps,
      cameraMs: this._cameraMs,
      tileReqMs: this._tileReqMs,
      drawMs: this._drawMs,
      totalMs,
      drawCalls: scene.renderer.stats.drawCalls,
      coloredInstances: scene.renderer.stats.coloredInstances,
      texturedInstances: scene.renderer.stats.texturedInstances,
      bytesUploaded: scene.renderer.stats.bytesUploaded,
      tileCacheSize: scene.cache.size(),
      tileCacheHits: this._tileCacheHits,
      tileCacheMisses: this._tileCacheMisses,
      textureCacheSize: scene.textures.size(),
      zoom: scene.camera.zoom,
      zoomTarget: scene.camera.zoomTarget,
      centerX: scene.camera.centerX,
      centerY: scene.camera.centerY,
      tilesGenerated: this._tilesGenerated,
      tileGenMs: this._tileGenMs,
      drop: isDrop,
      dropReason,
    };

    if (this._ring.length >= RING_CAPACITY) this._ring.shift();
    this._ring.push(frame);

    // Reset per-frame accumulators
    this._cameraMs = 0;
    this._tileReqMs = 0;
    this._drawMs = 0;
    this._tilesGenerated = 0;
    this._tileGenMs = 0;
    this._tileCacheHits = 0;
    this._tileCacheMisses = 0;
  }

  // ─── Data extraction ───────────────────────────────────────────────────

  /** Get all recorded frames. */
  getFrames(): readonly TraceFrame[] {
    return this._ring;
  }

  /** Get frames + clear buffer. Used by Playwright to pull data. */
  flush(): TraceFrame[] {
    const data = this._ring.slice();
    this._ring.length = 0;
    this._frameIdx = 0;
    return data;
  }

  /** Compute summary statistics from current buffer. */
  summarize(): TraceSummary {
    const frames = this._ring;
    const n = frames.length;
    if (n === 0) return emptySummary();

    const frameTimes = frames.map(f => f.dt).sort((a, b) => a - b);
    const drawTimes = frames.map(f => f.drawMs).sort((a, b) => a - b);
    const fpsList = frames.map(f => f.fps);
    const dropFrames = frames.filter(f => f.drop);

    // Find zoom ranges where drops cluster
    const dropZones = clusterDropZones(dropFrames);

    // Top N slowest frames
    const slowest = frames.slice().sort((a, b) => b.dt - a.dt).slice(0, SLOWEST_COUNT);

    return {
      totalFrames: n,
      durationMs: frames[n - 1].ts - frames[0].ts,
      avgFps: fpsList.reduce((a, b) => a + b, 0) / n,
      minFps: Math.min(...fpsList.filter(f => f > 0)),
      drops: dropFrames.length,
      dropFrames: dropFrames.slice(0, 100), // cap to prevent huge payloads
      frameTimes: percentiles(frameTimes),
      drawTimes: percentiles(drawTimes),
      slowest,
      dropZones,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentiles(sorted: number[]): TraceSummary['frameTimes'] {
  const n = sorted.length;
  if (n === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  return {
    p50: sorted[Math.floor(n * 0.50)],
    p90: sorted[Math.floor(n * 0.90)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.min(n - 1, Math.floor(n * 0.99))],
    max: sorted[n - 1],
  };
}

function clusterDropZones(drops: TraceFrame[]): TraceSummary['dropZones'] {
  if (drops.length === 0) return [];
  const bucketSize = 2; // group drops into 2-zoom-level buckets
  const buckets = new Map<number, number>();
  for (const d of drops) {
    const key = Math.floor(d.zoom / bucketSize) * bucketSize;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([z, count]) => ({ zoomMin: z, zoomMax: z + bucketSize, count }))
    .sort((a, b) => b.count - a.count);
}

function emptySummary(): TraceSummary {
  return {
    totalFrames: 0, durationMs: 0, avgFps: 0, minFps: 0,
    drops: 0, dropFrames: [], frameTimes: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 },
    drawTimes: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 },
    slowest: [], dropZones: [],
  };
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/** Global singleton. Import and use directly — no need to pass around. */
export const perfTrace = new PerfTraceImpl();

// Auto-enable via query param: `?perf-trace` or `?perf-trace=30` (threshold).
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  if (params.has('perf-trace')) {
    const threshold = parseInt(params.get('perf-trace') ?? '', 10);
    perfTrace.enable({ dropThreshold: isNaN(threshold) ? undefined : threshold });
  }
  // Expose for Playwright access.
  (window as unknown as Record<string, unknown>).__PERF_TRACE__ = perfTrace;
}
