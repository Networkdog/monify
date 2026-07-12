// Kinematic camera with decoupled pan + zoom state so that panning and
// zooming animations can run simultaneously.
//
// World coordinate convention:
//   - 1 world unit = 1 tile at zoom 0.
//   - Screen scale at zoom z = TILE_SIZE * 2^z   (pixels per world unit).
//   - Y increases downward (matches map-tile convention).

import { POW2, TILE_SIZE } from '../constants';

export interface CameraOptions {
  /** Lower bound on zoom. Default 0. Upper bound is unbounded by design. */
  minZoom?: number;
  /** Higher bound on zoom (safety only). Default 32. */
  maxZoom?: number;
  /** Half-life (seconds) of pan inertia decay. Smaller = stops sooner. */
  panHalfLife?: number;
  /** Zoom spring stiffness (1/seconds). Higher = snappier. */
  zoomStiffness?: number;
  /** Damping ratio for zoom spring (1.0 = critically damped). */
  zoomDamping?: number;
  /** Minimum |velocity| (world units / s) considered moving. */
  velEpsilon?: number;
}

export class Camera {
  /** Center of view in world coordinates. */
  centerX = 0;
  centerY = 0;
  /** Current fractional zoom; integer values match tile levels. */
  zoom = 0;

  /** Target zoom — wheel snaps to integers, spring chases it. */
  zoomTarget = 0;
  /** Velocity of fractional zoom (z-units / s). */
  zoomVel = 0;

  /** Pan inertial velocity in world units / s. */
  velX = 0;
  velY = 0;

  readonly opts: Required<CameraOptions>;

  constructor(opts: CameraOptions = {}) {
    this.opts = {
      minZoom: opts.minZoom ?? 0,
      maxZoom: opts.maxZoom ?? 32,
      panHalfLife: opts.panHalfLife ?? 0.14,
      zoomStiffness: opts.zoomStiffness ?? 22,
      zoomDamping: opts.zoomDamping ?? 1.0,
      velEpsilon: opts.velEpsilon ?? 1e-6,
    };
  }

  /** Pixels per world unit at current zoom. */
  get scale(): number {
    return TILE_SIZE * Math.pow(2, this.zoom);
  }

  scaleAt(zoom: number): number {
    return TILE_SIZE * POW2[zoom];
  }

  /** Convert a screen-space delta (px) into a world-space delta at current zoom. */
  screenDeltaToWorld(dx: number, dy: number): [number, number] {
    const s = this.scale;
    return [dx / s, dy / s];
  }

  /** Screen point (px) → world coordinates given canvas size in CSS px. */
  screenToWorld(sx: number, sy: number, viewW: number, viewH: number): [number, number] {
    const s = this.scale;
    return [this.centerX + (sx - viewW / 2) / s, this.centerY + (sy - viewH / 2) / s];
  }

  /** World point → screen pixels. */
  worldToScreen(wx: number, wy: number, viewW: number, viewH: number): [number, number] {
    const s = this.scale;
    return [(wx - this.centerX) * s + viewW / 2, (wy - this.centerY) * s + viewH / 2];
  }

  /** Apply a screen-space drag delta directly (no inertia injected). */
  panByScreen(dx: number, dy: number): void {
    const [wx, wy] = this.screenDeltaToWorld(dx, dy);
    this.centerX -= wx;
    this.centerY -= wy;
    // If a zoom anchor is active, slide the anchored world point along with
    // the pan so the zoom integrator pins the *new* world point under the
    // cursor instead of yanking the view back to the original anchor.
    if (this._anchorWorld) {
      this._anchorWorld[0] -= wx;
      this._anchorWorld[1] -= wy;
    }
  }

  /** Inject inertial velocity from a release. Values in world units / s. */
  setVelocity(vxWorld: number, vyWorld: number): void {
    this.velX = vxWorld;
    this.velY = vyWorld;
  }

  /** Stop pan inertia (e.g. on mousedown). */
  cancelPanInertia(): void {
    this.velX = 0;
    this.velY = 0;
  }

  /**
   * Zoom by an integer step, anchored at a screen-space point. Multiple calls
   * accumulate on the target so rapid wheels stay continuous.
   */
  zoomByStep(step: number, anchorSx: number, anchorSy: number, viewW: number, viewH: number): void {
    // Snap onto the integer zoom grid so every notch lands on a whole level.
    // Stepping up goes to the next integer above the current target, down to
    // the next below — so a fractional start (e.g. the fit zoom) doesn't skip
    // a level.
    const base = step > 0 ? Math.floor(this.zoomTarget) : Math.ceil(this.zoomTarget);
    const next = clamp(base + step, this.opts.minZoom, this.opts.maxZoom);
    if (next === this.zoomTarget) return;
    // Save the world point under the anchor so we can keep it pinned across the
    // animation; the per-frame integrator does the actual correction.
    this._anchorWorld = this.screenToWorld(anchorSx, anchorSy, viewW, viewH);
    this._anchorScreen = [anchorSx, anchorSy];
    this._anchorView = [viewW, viewH];
    this.zoomTarget = next;
  }

  /** Internal anchor state used by per-frame integration. */
  private _anchorWorld: [number, number] | null = null;
  private _anchorScreen: [number, number] | null = null;
  private _anchorView: [number, number] | null = null;

  /** Drop any pending zoom anchor (e.g. when a flight takes over the camera). */
  clearZoomAnchor(): void {
    this._anchorWorld = null;
    this._anchorScreen = null;
    this._anchorView = null;
  }

  /**
   * Advance simulation by `dt` seconds. Pan inertia and zoom spring are
   * independent so they can run in parallel; user-driven pan input is applied
   * directly via `panByScreen` and is composed naturally in the same frame.
   */
  update(dt: number): boolean {
    let moved = false;

    // --- Pan inertia: exponential decay toward zero velocity ---
    const { panHalfLife, velEpsilon } = this.opts;
    // Scale epsilon by 1/scale so it acts as a screen-space threshold
    // regardless of zoom level. Without this, deep zoom velocities (tiny
    // in world units) are killed immediately.
    const eps = velEpsilon / this.scale;
    if (Math.abs(this.velX) > eps || Math.abs(this.velY) > eps) {
      const decay = Math.pow(0.5, dt / panHalfLife);
      // Integrate then decay (semi-implicit gives nice feel).
      const dxw = this.velX * dt;
      const dyw = this.velY * dt;
      this.centerX += dxw;
      this.centerY += dyw;
      // Keep zoom anchor (if any) attached to the same screen pixel while
      // inertial pan slides the view.
      if (this._anchorWorld) {
        this._anchorWorld[0] += dxw;
        this._anchorWorld[1] += dyw;
      }
      this.velX *= decay;
      this.velY *= decay;
      moved = true;
    } else if (this.velX !== 0 || this.velY !== 0) {
      this.velX = 0;
      this.velY = 0;
    }

    // --- Zoom spring (critically damped by default) ---
    const dz = this.zoomTarget - this.zoom;
    if (Math.abs(dz) > 1e-5 || Math.abs(this.zoomVel) > 1e-4) {
      const k = this.opts.zoomStiffness;
      const c = 2 * this.opts.zoomDamping * Math.sqrt(k);
      const accel = k * dz - c * this.zoomVel;
      this.zoomVel += accel * dt;
      const beforeZoom = this.zoom;
      this.zoom += this.zoomVel * dt;

      // Keep anchor world point pinned to the same screen pixel.
      if (this._anchorWorld && this._anchorScreen && this._anchorView) {
        const [aw0, aw1] = this._anchorWorld;
        const [as0, as1] = this._anchorScreen;
        const [vw, vh] = this._anchorView;
        // After zoom change, the world point under the anchor pixel given the
        // *current* center would be:
        const s = this.scale;
        const wxNow = this.centerX + (as0 - vw / 2) / s;
        const wyNow = this.centerY + (as1 - vh / 2) / s;
        // Shift center so the anchor world point lines up again.
        this.centerX += aw0 - wxNow;
        this.centerY += aw1 - wyNow;
      }

      // Clamp + settle.
      if (this.zoom < this.opts.minZoom) {
        this.zoom = this.opts.minZoom;
        this.zoomVel = 0;
      } else if (this.zoom > this.opts.maxZoom) {
        this.zoom = this.opts.maxZoom;
        this.zoomVel = 0;
      }
      if (Math.abs(this.zoomTarget - this.zoom) < 1e-4 && Math.abs(this.zoomVel) < 1e-3) {
        this.zoom = this.zoomTarget;
        this.zoomVel = 0;
        this._anchorWorld = null;
        this._anchorScreen = null;
        this._anchorView = null;
      }
      if (this.zoom !== beforeZoom) moved = true;
    }

    return moved;
  }

  /** Returns true if camera has any pending motion (input still in flight). */
  isAnimating(): boolean {
    const { velEpsilon } = this.opts;
    return (
      Math.abs(this.velX) > velEpsilon ||
      Math.abs(this.velY) > velEpsilon ||
      Math.abs(this.zoomTarget - this.zoom) > 1e-4 ||
      Math.abs(this.zoomVel) > 1e-4
    );
  }

  /** Update the allowed zoom range at runtime. */
  setZoomRange(minZoom: number, maxZoom: number): void {
    this.opts.minZoom = minZoom;
    this.opts.maxZoom = maxZoom;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
