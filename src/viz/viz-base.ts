// VizBase — shared lifecycle for every monify visualization tool.
//
// It owns the vendored engine (Scene + Camera + InputController), a fixed-step
// render loop, hover/click hit-testing with a tooltip, and smooth click-to-zoom
// flight. Subclasses implement `buildTile` (procedural tile geometry from their
// data model) and optionally `onStep` (per-frame animation), `hitTest`, and
// `pick`.
//
// Real-time animation model: subclasses mutate their data model in `onStep`
// (e.g. tween values toward targets). When the model changes they call
// `invalidate()`, which clears the tile cache and marks the scene dirty. Because
// a direct `tileSource` regenerates tiles synchronously before `draw()`, the
// next frame renders fresh geometry with no flicker — giving smooth reflow.

import { Scene, type SceneOptions } from '../core/scene';
import { InputController } from '../core/camera';
import { AdaptiveQuality } from '../core/perf';
import { FIXED_STEP, MAX_STEPS_PER_FRAME } from '../core/constants';
import type { RGBA } from '../core/types';
import type { TileJSON } from '../core/tile';
import { Tooltip, type TooltipData } from './tooltip';
import { FlyController, type FlyTarget } from './fly';

export interface VizBaseOptions {
  /** Canvas to render into. */
  canvas: HTMLCanvasElement;
  /** Background clear color (engine RGBA). */
  background?: RGBA;
  /** Min integer tile zoom (most zoomed out). Default 0. */
  minTileZ?: number;
  /** Max integer tile zoom (most zoomed in). Default 24. */
  maxTileZ?: number;
  /** Camera zoom range. Defaults to [minTileZ, maxTileZ]. */
  zoomRange?: [number, number];
  /** Initial camera view. */
  initialView?: { x?: number; y?: number; zoom?: number };
}

const DRAG_THRESHOLD_PX = 4;

export abstract class VizBase {
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly input: InputController;
  protected readonly tooltip: Tooltip;
  protected readonly fly = new FlyController();

  readonly minTileZ: number;
  readonly maxTileZ: number;

  /** Frames-per-second, updated ~2×/second. */
  fps = 0;

  private readonly quality: AdaptiveQuality;
  private readonly resizeObs: ResizeObserver;

  private fpsFrames = 0;
  private fpsLast = 0;
  private last = 0;
  private accum = 0;
  private lastCX = 0;
  private lastCY = 0;
  private lastZ = 0;
  private raf = 0;
  private running = false;

  // Hover / click pointer tracking.
  private downX = 0;
  private downY = 0;
  private moved = false;
  private hoverX = 0;
  private hoverY = 0;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;

  constructor(opts: VizBaseOptions) {
    this.canvas = opts.canvas;
    this.minTileZ = opts.minTileZ ?? 0;
    this.maxTileZ = opts.maxTileZ ?? 24;

    const sceneOpts: SceneOptions = {
      tileSource: (z, x, y) => this.buildTile(z, x, y),
      minTileZ: this.minTileZ,
      maxTileZ: this.maxTileZ,
      tileMargin: (z) => this.tileMargin(z),
    };
    if (opts.background) sceneOpts.background = opts.background;
    this.scene = new Scene(this.canvas, sceneOpts);

    const [minZ, maxZ] = opts.zoomRange ?? [this.minTileZ, this.maxTileZ];
    this.scene.camera.setZoomRange(minZ, maxZ);
    const iv = opts.initialView ?? {};
    this.scene.camera.centerX = iv.x ?? 0.5;
    this.scene.camera.centerY = iv.y ?? 0.5;
    this.scene.camera.zoom = iv.zoom ?? minZ;
    this.scene.camera.zoomTarget = iv.zoom ?? minZ;

    this.quality = new AdaptiveQuality(this.scene);

    const getViewSize = (): [number, number] => {
      const r = this.canvas.getBoundingClientRect();
      return [r.width, r.height];
    };
    const syncResize = (): void => {
      const r = this.canvas.getBoundingClientRect();
      this.scene.resize(r.width, r.height, window.devicePixelRatio || 1);
      this.onResize(r.width, r.height);
    };
    syncResize();
    this.resizeObs = new ResizeObserver(syncResize);
    this.resizeObs.observe(this.canvas);

    this.input = new InputController(this.canvas, this.scene.camera, getViewSize, () => {
      this.fly.cancel();
    });

    this.tooltip = new Tooltip(this.canvas.parentElement ?? document.body);

    // Hover / click handlers (separate from InputController's pan/zoom).
    this.onPointerDown = (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.moved = false;
    };
    this.onPointerMove = (e) => {
      if (e.buttons !== 0) {
        if (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > DRAG_THRESHOLD_PX) {
          this.moved = true;
        }
        this.tooltip.hide();
        return;
      }
      this.hoverX = e.clientX;
      this.hoverY = e.clientY;
      this.updateHover();
    };
    this.onPointerUp = (e) => {
      if (e.button !== 0 || this.moved) return;
      const [wx, wy] = this.clientToWorld(e.clientX, e.clientY);
      this.pick(wx, wy, this.currentTileZ);
    };
    this.onPointerLeave = () => this.tooltip.hide();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.last = performance.now();
    this.fpsLast = this.last;
    this.lastCX = this.scene.camera.centerX;
    this.lastCY = this.scene.camera.centerY;
    this.lastZ = this.scene.camera.zoom;
  }

  // ── Subclass contract ──────────────────────────────────────────────────────

  /** Produce the geometry for a tile. Called synchronously during the loop. */
  protected abstract buildTile(z: number, x: number, y: number): TileJSON;

  /** Advance per-frame animation. Return true if the model changed this step. */
  protected onStep(_dt: number): boolean {
    return false;
  }

  /** Return tooltip content for a hovered world point, or null. */
  protected hitTest(_wx: number, _wy: number, _z: number): TooltipData | null {
    return null;
  }

  /** Handle a click at a world point (e.g. fly into a cell). */
  protected pick(_wx: number, _wy: number, _z: number): void {
    /* default: no-op */
  }

  /** Extra tile margin (in tiles) around the viewport for a given zoom. */
  protected tileMargin(_z: number): number {
    return 1;
  }

  /** Called after each frame; `drawn` is true when the frame rendered. */
  protected afterFrame(_drawn: boolean): void {
    /* default: no-op */
  }

  /** Called after the canvas is (re)sized to `w`×`h` CSS pixels. */
  protected onResize(_w: number, _h: number): void {
    /* default: no-op */
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** The current integer tile zoom (rounded, clamped to the tile range). */
  get currentTileZ(): number {
    const z = Math.round(this.scene.camera.zoom);
    return Math.max(this.minTileZ, Math.min(this.maxTileZ, z));
  }

  /** Smoothly fly the camera to a target view. */
  flyTo(target: FlyTarget): void {
    this.fly.start(this.scene.camera, target);
    this.scene.markDirty();
  }

  /** Drop cached tiles and force regeneration on the next frame. */
  invalidate(): void {
    this.scene.cache.clear();
    this.scene.markDirty();
  }

  /** Start the render loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Pause the render loop. */
  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Tear down all listeners and DOM. */
  destroy(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.input.destroy();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.tooltip.destroy();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private clientToWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return this.scene.camera.screenToWorld(clientX - r.left, clientY - r.top, r.width, r.height);
  }

  private updateHover(): void {
    const [wx, wy] = this.clientToWorld(this.hoverX, this.hoverY);
    const data = this.hitTest(wx, wy, this.currentTileZ);
    if (data) this.tooltip.show(data, this.hoverX, this.hoverY);
    else this.tooltip.hide();
  }

  private frame(now: number): void {
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    this.accum += Math.min(rawDt, 0.25);

    this.fpsFrames++;
    if (now - this.fpsLast >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLast));
      this.fpsFrames = 0;
      this.fpsLast = now;
    }

    const cam = this.scene.camera;
    let camMoved = false;
    let steps = 0;
    while (this.accum >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      const flying = this.fly.step(cam, FIXED_STEP);
      if (this.onStep(FIXED_STEP)) camMoved = true;
      if (flying) camMoved = true;
      else if (cam.update(FIXED_STEP)) camMoved = true;
      this.accum -= FIXED_STEP;
      steps++;
    }
    if (steps === 0 && !this.fly.isActive) cam.update(FIXED_STEP);
    if (steps >= MAX_STEPS_PER_FRAME) this.accum = 0;

    const inputChanged =
      cam.centerX !== this.lastCX || cam.centerY !== this.lastCY || cam.zoom !== this.lastZ;
    const sceneDirty = this.scene.consumeDirty();
    const shouldDraw =
      sceneDirty || camMoved || inputChanged || cam.isAnimating() || this.fly.isActive;

    if (!shouldDraw) {
      this.afterFrame(false);
      return;
    }

    this.scene.refreshTileRequests();
    const t0 = performance.now();
    this.scene.draw();
    this.quality.update(performance.now() - t0);

    this.lastCX = cam.centerX;
    this.lastCY = cam.centerY;
    this.lastZ = cam.zoom;
    this.afterFrame(true);
  }
}
