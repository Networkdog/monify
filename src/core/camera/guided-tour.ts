// ---------------------------------------------------------------------------
// GuidedTour — drives the camera through a polyline of stops along a smooth
// Catmull-Rom spline at constant on-screen speed.
//
// Behavior summary
// ----------------
//  - Stops are points in (x, y, zoom) world-space.
//  - The path between stops is a centripetal-friendly Catmull-Rom spline so
//    the camera curves through each stop instead of taking right angles.
//  - "Constant speed" is measured in screen-pixel arc-length along the spline
//    (panning at deep zoom does NOT crawl, and zoom-only legs still take time
//    proportional to the visual change).
//  - Per-stop `hold` lets the tour pause for the user to read.
//  - `loop: true` wraps the path back to the first stop indefinitely.
//  - Any user-initiated camera input (drag, wheel, arrow keys) should call
//    `cancel()` from the surrounding harness — the tour does not listen to
//    DOM events itself, keeping it framework-agnostic.
//
// Integration contract
// --------------------
//  - `tick(dt)` returns `true` when it advanced the camera; callers should
//    SKIP their normal `camera.update(dt)` for the frame in that case so the
//    spring/inertia integrator doesn't fight the scripted motion.
//  - The tour writes directly to `cam.centerX / centerY / zoom`, cancels
//    inertia, and clamps `zoomTarget` / `zoomVel` to 0 each frame.
// ---------------------------------------------------------------------------

import type { Camera } from './camera';
import { TILE_SIZE } from '../constants';

/** A single stop along the guided tour. */
export interface GuidedTourStop {
  /** World X coordinate (0..1 at zoom 0). */
  x: number;
  /** World Y coordinate (0..1 at zoom 0). */
  y: number;
  /** Camera zoom level when arriving at this stop. */
  zoom: number;
  /**
   * Optional pause (seconds) at the stop before continuing.
   * Use this to let the viewer read a label or take in the scene.
   */
  hold?: number;
}

/** Per-tour configuration knobs. */
export interface GuidedTourOptions {
  /** Wrap the path back to the first stop indefinitely. Default false. */
  loop?: boolean;
  /**
   * Travel speed in screen pixels per second along the spline.
   * The arc-length metric uses `2^zoom * TILE_SIZE` to convert world-units
   * to screen-pixels, so the camera feels equally fast at any zoom level.
   * A zoom-only leg contributes `|Δzoom| * zoomScreenCost` pixels of length.
   * Default 250.
   */
  speed?: number;
  /**
   * How many screen-pixels of arc-length one zoom-unit contributes.
   * Higher = zoom changes take longer relative to pans. Default 200.
   */
  zoomScreenCost?: number;
  /**
   * Catmull-Rom tension in [0, 1]. 0 = standard curvy CR, 1 = piecewise-linear.
   * Default 0 (smooth curves through every stop).
   */
  tension?: number;
  /** Notified when the tour ends naturally or via cancel(). */
  onEnd?: (reason: 'completed' | 'cancelled') => void;
}

/** Full tour definition — usable as a JSON literal. */
export interface GuidedTourConfig extends GuidedTourOptions {
  stops: GuidedTourStop[];
}

interface Sample {
  distance: number;
  x: number;
  y: number;
  zoom: number;
}

const DEFAULT_SPEED = 250;
const DEFAULT_ZOOM_COST = 200;
const SAMPLES_PER_LEG = 32;

export class GuidedTour {
  /** True while the tour is actively driving the camera. */
  active = false;

  private cam: Camera;
  private stops: GuidedTourStop[] = [];
  private loop = false;
  private speed = DEFAULT_SPEED;
  private zoomScreenCost = DEFAULT_ZOOM_COST;
  private tension = 0;
  private onEnd?: (reason: 'completed' | 'cancelled') => void;

  /** Densely sampled spline with cumulative arc-length in screen pixels. */
  private samples: Sample[] = [];
  /** Cumulative distance at each stop index (length = stops.length [+1 if loop]). */
  private stopAt: number[] = [];
  private totalLength = 0;
  /** Distance traveled along the spline so far (resets after looping). */
  private distance = 0;
  /** Remaining hold time at the current stop, in seconds. */
  private holdRemaining = 0;
  /** Index of the next upcoming stop (for hold-detection). */
  private nextStopIdx = 0;

  constructor(cam: Camera) {
    this.cam = cam;
  }

  /** Configure the tour (does not start). */
  configure(config: GuidedTourConfig): void {
    this.stops = config.stops.slice();
    this.loop = config.loop ?? false;
    this.speed = config.speed ?? DEFAULT_SPEED;
    this.zoomScreenCost = config.zoomScreenCost ?? DEFAULT_ZOOM_COST;
    this.tension = config.tension ?? 0;
    this.onEnd = config.onEnd;
    this._build();
  }

  /** Configure and start in one call. */
  play(config: GuidedTourConfig): void {
    this.configure(config);
    this.start();
  }

  /** Begin (or restart) the configured tour from the first stop. */
  start(): void {
    if (this.stops.length < 2) return;
    this.active = true;
    this.distance = 0;
    this.holdRemaining = this.stops[0].hold ?? 0;
    this.nextStopIdx = 1;
    this._snapToStop(this.stops[0]);
  }

  /** Stop the tour and fire `onEnd('cancelled')`. */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.onEnd?.('cancelled');
  }

  /**
   * Advance by `dt` seconds. Returns true if the camera was written this tick
   * (the caller should skip its normal camera.update in that case).
   */
  tick(dt: number): boolean {
    if (!this.active) return false;
    if (this.stops.length < 2 || this.totalLength <= 0) {
      this.active = false;
      return false;
    }

    // Honor "hold" at stops: stay anchored at the most recently reached stop
    // (which is `nextStopIdx - 1` after the boundary crossing below).
    if (this.holdRemaining > 0) {
      this.holdRemaining -= dt;
      const heldStopIdx = ((this.nextStopIdx - 1) % this.stops.length + this.stops.length) % this.stops.length;
      this._snapToStop(this.stops[heldStopIdx]);
      return true;
    }

    this.distance += this.speed * dt;

    // Boundary crossings: trigger hold at the first crossed stop with hold > 0,
    // otherwise advance the upcoming-stop pointer and continue.
    while (this.nextStopIdx < this.stopAt.length &&
           this.distance >= this.stopAt[this.nextStopIdx]) {
      const stopIdx = this.nextStopIdx;
      const stop = this.stops[stopIdx % this.stops.length];
      const hold = stop.hold ?? 0;
      this.nextStopIdx++;
      if (hold > 0) {
        // Snap exactly to the stop and pause.
        this.distance = this.stopAt[stopIdx];
        this.holdRemaining = hold;
        this._snapToStop(stop);
        return true;
      }
    }

    if (this.distance >= this.totalLength) {
      if (this.loop) {
        this.distance -= this.totalLength;
        this.nextStopIdx = 1;
        while (this.nextStopIdx < this.stopAt.length &&
               this.distance >= this.stopAt[this.nextStopIdx]) {
          this.nextStopIdx++;
        }
      } else {
        this._snapToStop(this.stops[this.stops.length - 1]);
        this.active = false;
        this.onEnd?.('completed');
        return true;
      }
    }

    const pose = this._sampleAt(this.distance);
    this.cam.cancelPanInertia();
    this.cam.zoomVel = 0;
    this.cam.centerX = pose.x;
    this.cam.centerY = pose.y;
    this.cam.zoom = this._clampZoom(pose.zoom);
    this.cam.zoomTarget = this.cam.zoom;
    return true;
  }

  private _clampZoom(z: number): number {
    const lo = this.cam.opts.minZoom;
    const hi = this.cam.opts.maxZoom;
    return z < lo ? lo : z > hi ? hi : z;
  }

  private _snapToStop(s: GuidedTourStop): void {
    this.cam.cancelPanInertia();
    this.cam.zoomVel = 0;
    this.cam.centerX = s.x;
    this.cam.centerY = s.y;
    this.cam.zoom = this._clampZoom(s.zoom);
    this.cam.zoomTarget = this.cam.zoom;
  }

  // ─── Catmull-Rom spline construction ─────────────────────────────────────

  /**
   * Hermite-form Catmull-Rom with tension parameter.
   * tension=0 → standard CR (max curvature through midpoints).
   * tension=1 → straight-line interpolation between p1 and p2.
   */
  private _cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const m = 1 - this.tension;
    const tan0 = 0.5 * m * (p2 - p0);
    const tan1 = 0.5 * m * (p3 - p1);
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * p1 + h10 * tan0 + h01 * p2 + h11 * tan1;
  }

  /** Fetch a control component, with loop-wrap or end-clamp behavior. */
  private _ctrl(i: number, dim: 'x' | 'y' | 'zoom'): number {
    const n = this.stops.length;
    if (this.loop) return this.stops[((i % n) + n) % n][dim];
    const idx = i < 0 ? 0 : i >= n ? n - 1 : i;
    return this.stops[idx][dim];
  }

  /** Build dense samples + per-stop cumulative distance. */
  private _build(): void {
    this.samples = [];
    this.stopAt = [];
    this.totalLength = 0;
    if (this.stops.length < 2) return;

    const segCount = this.loop ? this.stops.length : this.stops.length - 1;
    let cumDist = 0;
    let prevX = this.stops[0].x;
    let prevY = this.stops[0].y;
    let prevZ = this.stops[0].zoom;
    this.samples.push({ distance: 0, x: prevX, y: prevY, zoom: prevZ });

    for (let i = 0; i < segCount; i++) {
      this.stopAt.push(cumDist);
      const p0x = this._ctrl(i - 1, 'x'), p1x = this._ctrl(i, 'x'),
            p2x = this._ctrl(i + 1, 'x'), p3x = this._ctrl(i + 2, 'x');
      const p0y = this._ctrl(i - 1, 'y'), p1y = this._ctrl(i, 'y'),
            p2y = this._ctrl(i + 1, 'y'), p3y = this._ctrl(i + 2, 'y');
      const p0z = this._ctrl(i - 1, 'zoom'), p1z = this._ctrl(i, 'zoom'),
            p2z = this._ctrl(i + 1, 'zoom'), p3z = this._ctrl(i + 2, 'zoom');

      for (let s = 1; s <= SAMPLES_PER_LEG; s++) {
        const t = s / SAMPLES_PER_LEG;
        const x = this._cr(p0x, p1x, p2x, p3x, t);
        const y = this._cr(p0y, p1y, p2y, p3y, t);
        const z = this._cr(p0z, p1z, p2z, p3z, t);
        // Convert world delta to screen-pixel delta at the avg zoom of the
        // micro-segment so deep-zoom pans aren't unfairly short.
        const avgZ = (prevZ + z) * 0.5;
        const sc = TILE_SIZE * Math.pow(2, avgZ);
        const dx = (x - prevX) * sc;
        const dy = (y - prevY) * sc;
        const dz = (z - prevZ) * this.zoomScreenCost;
        cumDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.samples.push({ distance: cumDist, x, y, zoom: z });
        prevX = x; prevY = y; prevZ = z;
      }
    }

    // Terminal marker (end of last segment).
    this.stopAt.push(cumDist);
    this.totalLength = cumDist;
  }

  /** Binary-search the dense samples and lerp between the bracketing pair. */
  private _sampleAt(distance: number): Sample {
    const samples = this.samples;
    if (samples.length === 0) return { distance: 0, x: 0, y: 0, zoom: 0 };
    if (distance <= 0) return samples[0];
    if (distance >= this.totalLength) return samples[samples.length - 1];

    let lo = 0, hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].distance <= distance) lo = mid;
      else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    const seg = b.distance - a.distance;
    const t = seg > 0 ? (distance - a.distance) / seg : 0;
    return {
      distance,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      zoom: a.zoom + (b.zoom - a.zoom) * t,
    };
  }
}
