import { Camera } from './camera';

const VEL_SAMPLE_COUNT = 5;
const VEL_SAMPLE_WINDOW_MS = 80;

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** Reason supplied to the `onUserInteract` callback. */
export type UserInteractReason = 'drag' | 'wheel' | 'keypan' | 'keyzoom';

/**
 * Mouse/wheel input controller. Reads native events and pushes deltas into a
 * camera. Drag releases compute averaged velocity from the last few samples to
 * inject inertia.
 *
 * Pass `onUserInteract` to be notified whenever the user actively manipulates
 * the camera (drag start, wheel, arrow keys, PageUp/PageDown). Used by the
 * guided-tour system to bail out of scripted motion as soon as the viewer
 * grabs the wheel.
 */
export class InputController {
  private el: HTMLElement;
  private getViewSize: () => [number, number];
  private onUserInteract?: (reason: UserInteractReason) => void;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private samples: Sample[] = [];

  private onDown: (e: PointerEvent) => void;
  private onMove: (e: PointerEvent) => void;
  private onUp: (e: PointerEvent) => void;
  private onWheel: (e: WheelEvent) => void;
  private onContext: (e: Event) => void;
  private onKeyDown: (e: KeyboardEvent) => void;

  constructor(
    el: HTMLElement,
    cam: Camera,
    getViewSize: () => [number, number],
    onUserInteract?: (reason: UserInteractReason) => void,
  ) {
    this.el = el;
    this.getViewSize = getViewSize;
    this.onUserInteract = onUserInteract;

    this.onDown = (e) => {
      if (e.button !== 0) return;
      this.el.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.samples.length = 0;
      this.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      cam.cancelPanInertia();
      this.onUserInteract?.('drag');
      e.preventDefault();
    };

    this.onMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      cam.panByScreen(dx, dy);
      const now = performance.now();
      this.samples.push({ t: now, x: e.clientX, y: e.clientY });
      // Trim window
      const cutoff = now - VEL_SAMPLE_WINDOW_MS;
      while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();
      if (this.samples.length > VEL_SAMPLE_COUNT * 2) this.samples.splice(0, this.samples.length - VEL_SAMPLE_COUNT * 2);
    };

    this.onUp = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

      // Average velocity over recent samples.
      const samples = this.samples;
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt > 0) {
          const sxPerSec = (last.x - first.x) / dt;
          const syPerSec = (last.y - first.y) / dt;
          // Screen velocity → world velocity. Drag moves world opposite to camera pan,
          // but panByScreen already moves center by -worldDelta. We're injecting the
          // *camera* velocity that would continue the drag, which is also negative of
          // screen delta in world units.
          const [wvx, wvy] = cam.screenDeltaToWorld(-sxPerSec, -syPerSec);
          cam.setVelocity(wvx, wvy);
        }
      }
      this.samples.length = 0;
    };

    this.onWheel = (e) => {
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const [vw, vh] = this.getViewSize();
      // Each notch = exactly ±1 zoom step. deltaY > 0 → zoom out.
      const step = e.deltaY > 0 ? -1 : 1;
      cam.zoomByStep(step, sx, sy, vw, vh);
      this.onUserInteract?.('wheel');
    };

    this.onContext = (e) => e.preventDefault();

    // Keyboard: arrow keys pan with inertia, PageUp/PageDown zoom
    this.onKeyDown = (e) => {
      const PAN_SPEED = 400; // screen px/s worth of velocity
      const [vw, vh] = this.getViewSize();
      switch (e.key) {
        case 'ArrowLeft': {
          const [wx] = cam.screenDeltaToWorld(-PAN_SPEED, 0);
          cam.setVelocity(wx, cam.velY);
          this.onUserInteract?.('keypan');
          e.preventDefault();
          break;
        }
        case 'ArrowRight': {
          const [wx] = cam.screenDeltaToWorld(PAN_SPEED, 0);
          cam.setVelocity(wx, cam.velY);
          this.onUserInteract?.('keypan');
          e.preventDefault();
          break;
        }
        case 'ArrowUp': {
          const [, wy] = cam.screenDeltaToWorld(0, -PAN_SPEED);
          cam.setVelocity(cam.velX, wy);
          this.onUserInteract?.('keypan');
          e.preventDefault();
          break;
        }
        case 'ArrowDown': {
          const [, wy] = cam.screenDeltaToWorld(0, PAN_SPEED);
          cam.setVelocity(cam.velX, wy);
          this.onUserInteract?.('keypan');
          e.preventDefault();
          break;
        }
        case 'PageUp':
          cam.zoomByStep(1, vw * 0.5, vh * 0.5, vw, vh);
          this.onUserInteract?.('keyzoom');
          e.preventDefault();
          break;
        case 'PageDown':
          cam.zoomByStep(-1, vw * 0.5, vh * 0.5, vw, vh);
          this.onUserInteract?.('keyzoom');
          e.preventDefault();
          break;
      }
    };

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
