// Smooth camera flight to a target (world x, y, zoom). Used for click-to-zoom
// navigation — e.g. flying into a TreeMap cell or a HexGrid workload. The path
// is an eased interpolation of position and zoom; while a flight is active it
// drives the camera directly and suppresses spring/inertia integration.

import type { Camera } from '../core/camera';

export interface FlyTarget {
  x: number;
  y: number;
  zoom: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class FlyController {
  private active = false;
  private t = 0;
  private duration = 0.6;
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private tx = 0;
  private ty = 0;
  private tz = 0;

  get isActive(): boolean {
    return this.active;
  }

  /** Begin a flight from the camera's current state to `target`. */
  start(cam: Camera, target: FlyTarget): void {
    cam.cancelPanInertia();
    cam.clearZoomAnchor();
    cam.zoomVel = 0;
    this.sx = cam.centerX;
    this.sy = cam.centerY;
    this.sz = cam.zoom;
    this.tx = target.x;
    this.ty = target.y;
    // Land on a whole zoom level and leave zoomTarget at that integer, so an
    // interrupted flight is finished off by the zoom spring instead of
    // freezing at a fractional level.
    this.tz = Math.max(cam.opts.minZoom, Math.min(cam.opts.maxZoom, Math.round(target.zoom)));
    cam.zoomTarget = this.tz;
    this.t = 0;
    // Duration grows with zoom distance so big jumps feel deliberate, small
    // ones feel snappy. Spatial distance is tiny in world units at deep zoom,
    // so zoom distance dominates.
    const dz = Math.abs(this.tz - this.sz);
    this.duration = Math.min(1.2, Math.max(0.45, 0.45 + dz * 0.12));
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  /** Advance the flight. Returns true while the camera is under flight control. */
  step(cam: Camera, dt: number): boolean {
    if (!this.active) return false;
    this.t += dt / this.duration;
    const done = this.t >= 1;
    const k = easeInOutCubic(done ? 1 : this.t);
    cam.centerX = this.sx + (this.tx - this.sx) * k;
    cam.centerY = this.sy + (this.ty - this.sy) * k;
    cam.zoom = this.sz + (this.tz - this.sz) * k;
    // zoomTarget is intentionally left at the (integer) destination set in
    // start(), so a cancelled flight is completed by the spring.
    if (done) this.active = false;
    return true;
  }
}
