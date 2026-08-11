// TreeMap — a recursive, semantic-zoom treemap.
//
// The whole treemap lives in the world square [0,1]². Each node owns a world
// rect (from the squarified layout). A node renders as a single colored cell
// until it is large enough on screen (EXPAND_PX), at which point it "opens" and
// its children are drawn inside it instead — so zooming into a cell reveals a
// nested treemap, and zooming out collapses a subtree back into one aggregate
// cell (mean color + descendant count). Leaf values tween smoothly, reflowing
// the layout in real time.

import { VizBase } from '../viz-base';
import type { TileJSON, TileElement } from '../../core/tile';
import { TILE_SIZE } from '../../core/constants';
import type { RGBA } from '../../core/types';
import type { TooltipData } from '../tooltip';
import {
  BACKGROUND,
  GLYPH_DARK,
  GLYPH_LIGHT,
  NEUTRAL,
  sequential,
  categorical,
  type SequentialName,
  type CategoricalName,
  type ColorScale,
} from '../../color';
import {
  buildLiveTree,
  indexById,
  setLeafTarget,
  stepTween,
  computeColors,
  type TreeMapNode,
  type LiveNode,
} from './model';
import { layoutTree } from './layout';

/** Read-only view of a node passed to option callbacks. */
export interface TreeMapNodeInfo {
  id: string;
  label: string;
  depth: number;
  value: number;
  leafCount: number;
  meta?: Record<string, unknown>;
}

export interface TreeMapOptions {
  data: TreeMapNode;
  background?: RGBA;
  /** Color leaves by normalized value (sequential) or category (categorical). */
  colorBy?: 'value' | 'category';
  /** Palette name — a sequential name for 'value', categorical for 'category'. */
  palette?: SequentialName | CategoricalName;
  /** Optional 0..1 metric driving per-cell 3D height (Z extrusion). */
  heightMetric?: (node: TreeMapNodeInfo) => number;
  /** Exponential tween rate (1/s). Higher = snappier value animation. */
  tweenRate?: number;
  /** Max integer tile zoom (drill depth). Default 28. */
  maxZoom?: number;
}

const WORLD = { x0: 0, y0: 0, x1: 1, y1: 1 };
const DEFAULT_BG: RGBA = BACKGROUND;
const EXPAND_PX = 300;
const LABEL_MIN_PX = 46;
/** Max 3-D extrusion in screen px (constant at any zoom) for heightMetric=1. */
const HEIGHT_PX = 10;
/** Per-side cell inset in screen px — a constant-thickness separator at any zoom. */
const CELL_INSET_PX = 1;
/** Fraction of a parent cell reserved at the top for its caption strip. */
const HEADER_FRAC = 0.07;
/** Caption left pad and minimum center offset below the cell top, in screen px. */
const CAP_PAD_PX = 6;
const CAP_MIN_PX = 9;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a readable label color for a given background. */
function textColor(bg: RGBA): RGBA {
  const lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  return lum < 0.5 ? GLYPH_LIGHT : GLYPH_DARK;
}

function formatNum(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

export class TreeMap extends VizBase {
  private root: LiveNode;
  private byId: Map<string, LiveNode>;
  private valueDomain: [number, number] = [0, 1];
  private readonly colorBy: 'value' | 'category';
  private readonly paletteName: SequentialName | CategoricalName;
  private seqScale?: ColorScale;
  private catScale?: (i: number) => RGBA;
  private readonly tweenRate: number;
  private readonly heightMetric?: (n: TreeMapNodeInfo) => number;
  private readonly headerColor: RGBA;
  private fitted = false;

  constructor(canvas: HTMLCanvasElement, opts: TreeMapOptions) {
    super({
      canvas,
      background: opts.background ?? DEFAULT_BG,
      minTileZ: 0,
      maxTileZ: opts.maxZoom ?? 28,
    });
    this.headerColor = textColor(opts.background ?? DEFAULT_BG);
    this.colorBy = opts.colorBy ?? 'value';
    this.paletteName = opts.palette ?? (this.colorBy === 'category' ? 'aurora' : 'viridis');
    this.tweenRate = opts.tweenRate ?? 6;
    this.heightMetric = opts.heightMetric;
    if (this.colorBy === 'category') {
      this.catScale = categorical(this.paletteName as CategoricalName);
    }

    this.root = buildLiveTree(opts.data);
    this.byId = indexById(this.root);
    this.recomputeDomain();
    if (this.colorBy === 'value') {
      this.seqScale = sequential(this.paletteName as SequentialName, this.valueDomain);
    }
    this.relayout();
    this.recolor();
    this.start();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Update leaf values by id; the treemap animates toward the new sizes. */
  setValues(values: Record<string, number>): void {
    for (const id in values) {
      const n = this.byId.get(id);
      if (n) setLeafTarget(n, values[id]);
    }
    this.scene.markDirty();
  }

  /** Replace the entire dataset (rebuilds; resets animation). */
  setData(data: TreeMapNode): void {
    this.root = buildLiveTree(data);
    this.byId = indexById(this.root);
    this.recomputeDomain();
    if (this.colorBy === 'value') {
      this.seqScale = sequential(this.paletteName as SequentialName, this.valueDomain);
    }
    this.relayout();
    this.recolor();
    this.invalidate();
  }

  /** Current root label + total value (for demo HUDs). */
  get rootInfo(): TreeMapNodeInfo {
    return this.info(this.root);
  }

  // ── VizBase hooks ────────────────────────────────────────────────────────────

  protected override onStep(dt: number): boolean {
    const changed = stepTween(this.root, this.tweenRate, dt);
    if (changed) {
      this.relayout();
      this.recolor();
      this.invalidate();
    }
    return changed;
  }

  protected override onResize(w: number, h: number): void {
    if (!this.fitted && w > 1 && h > 1) {
      this.fitView(w, h);
      this.fitted = true;
    }
  }

  protected override buildTile(z: number, x: number, y: number): TileJSON {
    const span = 1 / Math.pow(2, z);
    const ox = x * span;
    const oy = y * span;
    const scale = TILE_SIZE * Math.pow(2, z);
    const out: TileElement[] = [];
    this.emit(this.root, ox, oy, ox + span, oy + span, scale, out);
    return { z, x, y, elements: out };
  }

  protected override hitTest(wx: number, wy: number, z: number): TooltipData | null {
    const scale = TILE_SIZE * Math.pow(2, z);
    const node = this.locate(this.root, wx, wy, scale);
    if (!node) return null;
    const total = this.root.current;
    const share = total > 0 ? (node.current / total) * 100 : 0;
    const body = [
      `value: ${formatNum(node.current)}`,
      `share: ${share.toFixed(1)}%`,
      `depth: ${node.depth}`,
    ];
    if (node.children.length > 0) body.push(`contains: ${node.leafCount} leaves`);
    return { title: node.label, body };
  }

  protected override pick(wx: number, wy: number, z: number): void {
    const scale = TILE_SIZE * Math.pow(2, z);
    const node = this.locate(this.root, wx, wy, scale);
    if (!node) return;
    const r = node.rect;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const rw = Math.max(1e-9, r.x1 - r.x0);
    const rh = Math.max(1e-9, r.y1 - r.y0);
    const rect = this.canvas.getBoundingClientRect();
    const vw = Math.max(1, rect.width);
    const vh = Math.max(1, rect.height);
    const targetScale = 0.9 * Math.min(vw / rw, vh / rh);
    const zoom = Math.max(
      this.minTileZ,
      Math.min(this.maxTileZ, Math.log2(targetScale / TILE_SIZE)),
    );
    this.flyTo({ x: cx, y: cy, zoom });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private recomputeDomain(): void {
    let lo = Infinity;
    let hi = -Infinity;
    const walk = (n: LiveNode): void => {
      if (n.children.length === 0) {
        if (n.target < lo) lo = n.target;
        if (n.target > hi) hi = n.target;
      } else {
        for (const c of n.children) walk(c);
      }
    };
    walk(this.root);
    if (!isFinite(lo) || !isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (lo === hi) hi = lo + 1;
    this.valueDomain = [lo, hi];
  }

  private leafColor = (n: LiveNode): RGBA => {
    if (this.colorBy === 'category' && this.catScale) {
      return this.catScale(n.category ?? hashId(n.id));
    }
    return this.seqScale ? this.seqScale(n.current) : NEUTRAL;
  };

  private relayout(): void {
    layoutTree(this.root, { ...WORLD }, HEADER_FRAC);
  }

  private recolor(): void {
    computeColors(this.root, this.leafColor);
  }

  private fitView(w: number, h: number): void {
    const side = Math.max(1, Math.min(w, h));
    const z = Math.log2(side / TILE_SIZE);
    const cam = this.scene.camera;
    cam.centerX = 0.5;
    cam.centerY = 0.5;
    cam.zoom = cam.zoomTarget = Math.max(this.minTileZ, Math.min(this.maxTileZ, z));
    this.scene.markDirty();
  }

  private info(n: LiveNode): TreeMapNodeInfo {
    return {
      id: n.id,
      label: n.label,
      depth: n.depth,
      value: n.current,
      leafCount: n.leafCount,
      meta: n.meta,
    };
  }

  private isExpanded(n: LiveNode, scale: number): boolean {
    if (n.children.length === 0) return false;
    const wsize = Math.min(n.rect.x1 - n.rect.x0, n.rect.y1 - n.rect.y0);
    return wsize * scale >= EXPAND_PX;
  }

  private emit(
    n: LiveNode,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    scale: number,
    out: TileElement[],
  ): void {
    const r = n.rect;
    if (r.x0 >= x1 || r.x1 <= x0 || r.y0 >= y1 || r.y1 <= y0) return; // no intersection
    if (this.isExpanded(n, scale)) {
      this.drawHeader(n, scale, out);
      for (const c of n.children) this.emit(c, x0, y0, x1, y1, scale, out);
    } else {
      this.drawCell(n, scale, out);
    }
  }

  private drawCell(n: LiveNode, scale: number, out: TileElement[]): void {
    const r = n.rect;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;

    let height = 0;
    if (this.heightMetric) {
      // Constant on-screen extrusion (screen px ÷ scale) so the 3-D relief — and
      // the perspective gaps it opens between raised cell tops — stays a fixed
      // thickness instead of growing without bound as you zoom in.
      height = clamp01(this.heightMetric(this.info(n))) * HEIGHT_PX / scale;
    }

    // The cell fills its rect exactly; a constant on-screen inset carves a
    // uniform separator from its neighbours that never grows with zoom.
    out.push({
      type: 'shape',
      shape: 'rect',
      x: r.x0,
      y: r.y0,
      w,
      h,
      fill: n.color,
      insetScreen: CELL_INSET_PX,
      height,
      layer: 1,
      depth: n.depth,
    });

    const px = Math.min(w, h) * scale;
    if (px >= LABEL_MIN_PX) {
      if (n.children.length > 0) {
        // Branch: caption at the top (the same anchor it keeps once expanded),
        // drawn on the cell fill.
        out.push(this.caption(n, scale, textColor(n.color), height));
      } else {
        // Leaf: caption centered.
        out.push({
          type: 'text',
          x: r.x0 + w / 2,
          y: r.y0 + h / 2,
          size: 13,
          text: n.label,
          color: textColor(n.color),
          align: 'center',
          floating: true,
          elevation: height,
          layer: 2,
          depth: n.depth,
        });
      }
    }
  }

  /** Build a top-left caption for a branch node (shared by collapsed/expanded). */
  private caption(n: LiveNode, scale: number, color: RGBA, elevation: number): TileElement {
    const r = n.rect;
    return {
      type: 'text',
      x: r.x0 + CAP_PAD_PX / scale,
      y: r.y0 + Math.max(n.headerH / 2, CAP_MIN_PX / scale),
      size: 13,
      text: `${n.label} (${n.leafCount})`,
      color,
      align: 'left',
      floating: true,
      elevation,
      layer: 2,
      depth: n.depth,
    };
  }

  /**
   * Draw an expanded parent's caption inside the blank strip reserved across
   * the top of its cell. The label floats at a constant screen size and sits
   * above the child cells instead of overlapping them.
   */
  private drawHeader(n: LiveNode, scale: number, out: TileElement[]): void {
    if (n.headerH <= 0 || n.children.length === 0) return;
    if (n.headerH * scale < 16) return; // strip too short to hold a label
    out.push(this.caption(n, scale, this.headerColor, 0));
  }

  private locate(n: LiveNode, wx: number, wy: number, scale: number): LiveNode | null {
    const r = n.rect;
    if (wx < r.x0 || wx > r.x1 || wy < r.y0 || wy > r.y1) return null;
    if (this.isExpanded(n, scale)) {
      for (const c of n.children) {
        const hit = this.locate(c, wx, wy, scale);
        if (hit) return hit;
      }
    }
    return n;
  }
}
