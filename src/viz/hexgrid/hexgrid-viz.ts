// HexGrid — a honeycomb workload monitor.
//
// Each workload occupies one or more hexagonal cells at a name-determined
// position (see placement.ts). Cell color encodes criticality (RdYlGn: green =
// healthy → red = critical); an active anomaly makes a workload pulse. Zooming
// crosses into the next semantic layer every few zoom levels, replacing each
// cell with a finer honeycomb that fills it (self-similar), while metric
// changes animate the colors smoothly in real time.

import { VizBase } from '../viz-base';
import type { TileJSON, TileElement } from '../../core/tile';
import { TILE_SIZE } from '../../core/constants';
import type { RGBA } from '../../core/types';
import type { TooltipData } from '../tooltip';
import { paletteStops, sampleStops, interpolateRgb } from '../../color';
import {
  axialToPixel,
  pixelToAxial,
  hexRound,
  hexPolygon,
  axialKey,
  spiralRadiusFor,
  type Axial,
} from './hex';
import { HexPlacer } from './placement';

export interface HexResourceInput {
  id: string;
  kind?: string;
  /** Severity 0..1 (0 = healthy, 1 = critical). */
  value: number;
}

export interface WorkloadInput {
  name: string;
  /** Number of cells this workload spans. Default 1. */
  size?: number;
  /** Criticality 0..1 (0 = healthy, 1 = critical). */
  criticality: number;
  resources?: HexResourceInput[];
  meta?: Record<string, unknown>;
}

export interface HexGridOptions {
  workloads: WorkloadInput[];
  background?: RGBA;
  /** Exponential tween rate (1/s) for criticality + resource animation. */
  tweenRate?: number;
  /** Max integer tile zoom. Default 26. */
  maxZoom?: number;
}

export interface WorkloadSummary {
  name: string;
  size: number;
}

interface LiveResource {
  id: string;
  kind: string;
  target: number;
  current: number;
}

interface LiveWorkload {
  name: string;
  cells: Axial[];
  worldCells: [number, number][];
  /** Merged boundary loop(s) of the cell cluster, in world coords. */
  outline: number[][];
  worldCenter: [number, number];
  clusterRadius: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  targetCrit: number;
  crit: number;
  pulse: number;
  resources: LiveResource[];
}

const FIT_SPAN = 0.9;
// Semantic-zoom layers. Every LAYER_SPAN zoom levels the current honeycomb is
// replaced by the next finer layer, whose cells subdivide each parent cell by
// LAYER_SUBDIV = 2^LAYER_SPAN (linear). That power-of-two keeps the zoom
// self-similar: the incoming layer's cells appear at exactly the on-screen size
// the parent layer had LAYER_SPAN levels earlier. With LAYER_BASE_Z = 1 the
// first swap lands on zoom 6.0, where child cells match the zoom-1.0 cell size.
// (For strict 6-unit spacing referenced to zoom 0, use LAYER_SPAN = 6 and
// LAYER_BASE_Z = 0.)
const LAYER_SPAN = 5;
const LAYER_SUBDIV = 2 ** LAYER_SPAN;
const LAYER_BASE_Z = 1;
const LABEL_PX = 54;
const PULSE_HALFLIFE = 1.6;
// 3D extrusion: each workload cell becomes a hex prism whose height (in units
// of the hex radius) encodes criticality — healthy = thin tile, critical = tall
// tower — with an extra spike while an anomaly pulses.
const HEIGHT_BASE = 0.25;
const HEIGHT_GAIN = 1.5;
const HEIGHT_PULSE = 0.75;
// Slight translucency for the workload prisms (see-through top + sides), and
// the inter-workload gap as a fraction of the hex radius.
const WORKLOAD_ALPHA = 0.68;
const GAP_FRAC = 0.08;
const HOT: RGBA = [1, 0.96, 0.75, 1];
const SQRT3 = Math.sqrt(3);

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Even-odd point-in-polygon test against a set of world-space rings (parity
 * across all rings so holes are handled). Used to keep the deep-zoom sub-layer
 * fill inside the same inset silhouette that layer 0 draws.
 */
function pointInRings(x: number, y: number, rings: number[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], yi = ring[i * 2 + 1];
      const xj = ring[j * 2], yj = ring[j * 2 + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Small deterministic hash of a sub-cell (q, r, layer) → uint32. */
function hashCell(q: number, r: number, layer: number): number {
  let h = (2166136261 ^ (q * 374761393) ^ (r * 668265263) ^ (layer * 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return (h ^ (h >>> 13)) >>> 0;
}

export class HexGrid extends VizBase {
  private readonly workloads: LiveWorkload[] = [];
  private readonly byName = new Map<string, LiveWorkload>();
  private readonly cellToWorkload = new Map<string, number>();
  private readonly critStops: RGBA[];
  private readonly tweenRate: number;

  private fitScale = 1;
  private cxb = 0;
  private cyb = 0;
  private worldHexRadius = 0.02;
  private clock = 0;
  private fitted = false;

  constructor(canvas: HTMLCanvasElement, opts: HexGridOptions) {
    super({
      canvas,
      background: opts.background ?? [0.05, 0.06, 0.08, 1],
      minTileZ: 0,
      maxTileZ: opts.maxZoom ?? 26,
    });
    this.tweenRate = opts.tweenRate ?? 5;
    this.critStops = paletteStops('rdylgn');

    // 1) Place every workload on the hex grid.
    const placer = new HexPlacer(spiralRadiusFor(opts.workloads.length * 2 + 8));
    const placed = opts.workloads.map((w) => ({
      input: w,
      p: placer.place(w.name, w.size ?? 1),
    }));

    // 2) Fit the honeycomb's unit-pixel bounding box into [0,1]².
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const { p } of placed) {
      for (const [q, r] of p.cells) {
        const [px, py] = axialToPixel(q, r, 1);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    if (!isFinite(minX)) {
      minX = minY = -1;
      maxX = maxY = 1;
    }
    this.cxb = (minX + maxX) / 2;
    this.cyb = (minY + maxY) / 2;
    const paddedW = maxX - minX + 2;
    const paddedH = maxY - minY + 2;
    this.fitScale = FIT_SPAN / Math.max(paddedW, paddedH, 1e-6);
    this.worldHexRadius = this.fitScale;

    // 3) Build the live model.
    for (const { input, p } of placed) {
      const worldCells = p.cells.map(([q, r]) => this.unitAxialToWorld(q, r));
      let sx = 0;
      let sy = 0;
      for (const c of worldCells) {
        sx += c[0];
        sy += c[1];
      }
      const worldCenter: [number, number] = [sx / worldCells.length, sy / worldCells.length];
      const clusterRadius = this.worldHexRadius * Math.max(1, Math.sqrt(p.cells.length));
      let bminx = Infinity;
      let bminy = Infinity;
      let bmaxx = -Infinity;
      let bmaxy = -Infinity;
      for (const c of worldCells) {
        bminx = Math.min(bminx, c[0] - this.worldHexRadius);
        bminy = Math.min(bminy, c[1] - this.worldHexRadius);
        bmaxx = Math.max(bmaxx, c[0] + this.worldHexRadius);
        bmaxy = Math.max(bmaxy, c[1] + this.worldHexRadius);
      }
      const live: LiveWorkload = {
        name: input.name,
        cells: p.cells,
        worldCells,
        outline: this.insetOutline(this.computeOutline(p.cells), this.worldHexRadius * GAP_FRAC),
        worldCenter,
        clusterRadius,
        bbox: { minx: bminx, miny: bminy, maxx: bmaxx, maxy: bmaxy },
        targetCrit: clamp01(input.criticality),
        crit: clamp01(input.criticality),
        pulse: 0,
        resources: (input.resources ?? []).map((res) => ({
          id: res.id,
          kind: res.kind ?? 'resource',
          target: clamp01(res.value),
          current: clamp01(res.value),
        })),
      };
      const idx = this.workloads.length;
      this.workloads.push(live);
      this.byName.set(live.name, live);
      for (const [q, r] of p.cells) this.cellToWorkload.set(axialKey(q, r), idx);
    }

    this.start();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Set a workload's target criticality (animates). */
  setCriticality(name: string, value: number): void {
    const w = this.byName.get(name);
    if (w) {
      w.targetCrit = clamp01(value);
      this.scene.markDirty();
    }
  }

  /** Set a resource's target severity (animates). */
  setResource(name: string, id: string, value: number): void {
    const w = this.byName.get(name);
    const res = w?.resources.find((r) => r.id === id);
    if (res) {
      res.target = clamp01(value);
      this.scene.markDirty();
    }
  }

  /** Flash an anomaly pulse on a workload. */
  triggerAnomaly(name: string, intensity = 1): void {
    const w = this.byName.get(name);
    if (w) {
      w.pulse = Math.max(w.pulse, clamp01(intensity));
      this.scene.markDirty();
    }
  }

  /** List placed workloads (for demo drivers). */
  listWorkloads(): WorkloadSummary[] {
    return this.workloads.map((w) => ({ name: w.name, size: w.cells.length }));
  }

  // ── VizBase hooks ────────────────────────────────────────────────────────────

  protected override onStep(dt: number): boolean {
    this.clock += dt;
    const k = 1 - Math.exp(-this.tweenRate * dt);
    const decay = Math.pow(0.5, dt / PULSE_HALFLIFE);
    let changed = false;
    for (const w of this.workloads) {
      const d = w.targetCrit - w.crit;
      if (Math.abs(d) > 1e-4) {
        w.crit += d * k;
        changed = true;
      } else {
        w.crit = w.targetCrit;
      }
      for (const res of w.resources) {
        const dd = res.target - res.current;
        if (Math.abs(dd) > 1e-4) {
          res.current += dd * k;
          changed = true;
        } else {
          res.current = res.target;
        }
      }
      if (w.pulse > 0.001) {
        w.pulse *= decay;
        changed = true;
      } else {
        w.pulse = 0;
      }
    }
    // While zoomed into a sub-layer the procedural fill is effectively static,
    // so skip the cache-clearing invalidate to keep deep zoom smooth; the live
    // workload colors resume updating once zoomed back out toward layer 0.
    if (changed && this.scene.camera.zoom < LAYER_BASE_Z + LAYER_SPAN) {
      this.invalidate();
    }
    return changed;
  }

  protected override onResize(w: number, h: number): void {
    if (!this.fitted && w > 1 && h > 1) {
      const side = Math.max(1, Math.min(w, h));
      const cam = this.scene.camera;
      cam.centerX = 0.5;
      cam.centerY = 0.5;
      cam.zoom = cam.zoomTarget = Math.max(
        this.minTileZ,
        Math.min(this.maxTileZ, Math.log2(side / TILE_SIZE)),
      );
      this.scene.markDirty();
      this.fitted = true;
    }
  }

  protected override buildTile(z: number, x: number, y: number): TileJSON {
    const span = 1 / Math.pow(2, z);
    const ox = x * span;
    const oy = y * span;
    const x1 = ox + span;
    const y1 = oy + span;
    const scale = TILE_SIZE * Math.pow(2, z);
    const out: TileElement[] = [];

    // Which semantic layer this tile zoom belongs to: 0 is the workload
    // honeycomb, deeper layers are progressively finer sub-cell fills.
    const layer = Math.max(0, Math.floor((z - LAYER_BASE_Z) / LAYER_SPAN));
    if (layer === 0) {
      const cellPx = 2 * this.worldHexRadius * scale;
      for (const w of this.workloads) {
        if (w.bbox.maxx <= ox || w.bbox.minx >= x1 || w.bbox.maxy <= oy || w.bbox.miny >= y1) {
          continue;
        }
        this.drawWorkload(w, cellPx, out);
      }
    } else {
      this.buildSubLayer(layer, ox, oy, x1, y1, out);
    }
    return { z, x, y, elements: out };
  }

  protected override hitTest(wx: number, wy: number, _z: number): TooltipData | null {
    const w = this.workloadAt(wx, wy);
    if (!w) return null;
    const sev = w.crit;
    const status = sev > 0.75 ? 'critical' : sev > 0.4 ? 'warning' : 'healthy';
    const body = [
      `status: ${status} (${(sev * 100).toFixed(0)}%)`,
      `cells: ${w.cells.length}`,
      `resources: ${w.resources.length}`,
    ];
    if (w.pulse > 0.01) body.push('⚠ anomaly active');
    if (w.resources.length > 0) {
      const worst = Math.max(...w.resources.map((r) => r.current));
      body.push(`worst resource: ${(worst * 100).toFixed(0)}%`);
    }
    return { title: w.name, body };
  }

  protected override pick(wx: number, wy: number, _z: number): void {
    const w = this.workloadAt(wx, wy);
    if (!w) return;
    const rect = this.canvas.getBoundingClientRect();
    const vw = Math.max(1, rect.width);
    const vh = Math.max(1, rect.height);
    const targetScale = (0.7 * Math.min(vw, vh)) / (2 * w.clusterRadius);
    const zoom = Math.max(
      this.minTileZ,
      Math.min(this.maxTileZ, Math.log2(targetScale / TILE_SIZE)),
    );
    this.flyTo({ x: w.worldCenter[0], y: w.worldCenter[1], zoom });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private unitAxialToWorld(q: number, r: number): [number, number] {
    const [ux, uy] = axialToPixel(q, r, 1);
    return [0.5 + (ux - this.cxb) * this.fitScale, 0.5 + (uy - this.cyb) * this.fitScale];
  }

  /**
   * Ordered boundary loop(s) of a workload's cell cluster, in world coords.
   * Edges shared by two cells of the same workload are interior and omitted,
   * so a multi-cell workload renders as one merged silhouette with no seams
   * between its own cells. Computed once (cells are static) per workload.
   */
  private computeOutline(cells: Axial[]): number[][] {
    const inSet = new Set<string>();
    for (const [q, r] of cells) inSet.add(axialKey(q, r));

    // Edge i (hex vertex i → i+1) faces this axial neighbor. Derived from the
    // pointy-top vertex angles used by hexPolygon (60·i − 90°).
    const EDGE_NEI: readonly Axial[] = [
      [1, -1],
      [1, 0],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [0, -1],
    ];

    // Quantize unit-space corners so the coincident corners of adjacent cells
    // collapse to one key despite last-bit floating-point differences.
    const Q = 1e5;
    const vkey = (x: number, y: number): string => `${Math.round(x * Q)}:${Math.round(y * Q)}`;

    const nextOf = new Map<string, string>();
    const posOf = new Map<string, [number, number]>();
    for (const [q, r] of cells) {
      const [cx, cy] = axialToPixel(q, r, 1);
      const poly = hexPolygon(cx, cy, 1);
      for (let i = 0; i < 6; i++) {
        const nb = EDGE_NEI[i];
        if (inSet.has(axialKey(q + nb[0], r + nb[1]))) continue; // interior edge
        const j = (i + 1) % 6;
        const ka = vkey(poly[i * 2], poly[i * 2 + 1]);
        const kb = vkey(poly[j * 2], poly[j * 2 + 1]);
        posOf.set(ka, [poly[i * 2], poly[i * 2 + 1]]);
        posOf.set(kb, [poly[j * 2], poly[j * 2 + 1]]);
        nextOf.set(ka, kb);
      }
    }

    // Walk the directed boundary edges into closed loop(s).
    const rings: number[][] = [];
    const used = new Set<string>();
    for (const start of nextOf.keys()) {
      if (used.has(start)) continue;
      const ring: number[] = [];
      let k: string | undefined = start;
      let guard = nextOf.size + 1;
      while (k !== undefined && !used.has(k) && guard-- > 0) {
        used.add(k);
        const p = posOf.get(k);
        if (!p) break;
        ring.push(0.5 + (p[0] - this.cxb) * this.fitScale, 0.5 + (p[1] - this.cyb) * this.fitScale);
        k = nextOf.get(k);
      }
      if (ring.length >= 6) rings.push(ring);
    }
    return rings;
  }

  /**
   * Shrink each outline ring inward (toward its own centroid) by `gap` world
   * units, giving a roughly-constant margin between neighbouring workloads
   * while a multi-cell workload stays merged as one shape.
   */
  private insetOutline(rings: number[][], gap: number): number[][] {
    return rings.map((ring) => {
      const n = ring.length >> 1;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += ring[i * 2];
        cy += ring[i * 2 + 1];
      }
      cx /= n;
      cy /= n;
      const out = new Array<number>(ring.length);
      for (let i = 0; i < n; i++) {
        const dx = ring[i * 2] - cx;
        const dy = ring[i * 2 + 1] - cy;
        const len = Math.hypot(dx, dy) || 1;
        const s = Math.max(0, len - gap) / len;
        out[i * 2] = cx + dx * s;
        out[i * 2 + 1] = cy + dy * s;
      }
      return out;
    });
  }

  private workloadAt(wx: number, wy: number): LiveWorkload | null {
    const ux = (wx - 0.5) / this.fitScale + this.cxb;
    const uy = (wy - 0.5) / this.fitScale + this.cyb;
    const [fq, fr] = pixelToAxial(ux, uy, 1);
    const [q, r] = hexRound(fq, fr);
    const idx = this.cellToWorkload.get(axialKey(q, r));
    return idx === undefined ? null : this.workloads[idx];
  }

  private critColor(severity: number): RGBA {
    return sampleStops(this.critStops, 1 - clamp01(severity));
  }

  private applyPulse(base: RGBA, pulse: number): RGBA {
    const osc = 0.5 + 0.5 * Math.sin(this.clock * 8);
    return interpolateRgb(base, HOT, clamp01(pulse) * osc * 0.75);
  }

  private drawWorkload(w: LiveWorkload, cellPx: number, out: TileElement[]): void {
    const base = this.critColor(w.crit);
    const lit = w.pulse > 0.001 ? this.applyPulse(base, w.pulse) : base;
    const height = this.worldHexRadius * (HEIGHT_BASE + w.crit * HEIGHT_GAIN + w.pulse * HEIGHT_PULSE);

    // One translucent extruded prism per workload from its inset merged
    // outline: cells of the same workload merge (no interior seam) while a gap
    // separates neighbouring workloads. Height + colour animate with crit.
    const fill: RGBA = [lit[0], lit[1], lit[2], WORKLOAD_ALPHA];
    out.push({
      type: 'extruded',
      rings: w.outline,
      height,
      fill,
      layer: 1,
      depth: 0,
    });

    if (cellPx >= LABEL_PX) {
      out.push({
        type: 'text',
        x: w.worldCenter[0],
        y: w.worldCenter[1],
        size: 11,
        text: w.name,
        color: [0.95, 0.97, 1, 1],
        align: 'center',
        floating: true,
        elevation: height,
        layer: 3,
        depth: 0,
      });
    }
  }

  /**
   * Fill the tile rect with the layer-L honeycomb: pointy-top hexes of world
   * radius worldHexRadius / LAYER_SUBDIV^L, aligned to the layer-0 honeycomb.
   * Each cell inherits the criticality colour of the workload beneath it (plus
   * a deterministic per-cell jitter). Cells outside every workload are skipped,
   * so a workload's own area reads as "filled" while the gaps between workloads
   * stay empty — preserving the overall honeycomb shape at every depth.
   */
  private buildSubLayer(
    layer: number,
    ox: number,
    oy: number,
    x1: number,
    y1: number,
    out: TileElement[],
  ): void {
    const cellR = this.worldHexRadius / Math.pow(LAYER_SUBDIV, layer);
    // Axial index range (pointy-top) covering the tile rect, relative to the
    // honeycomb centre at world (0.5, 0.5). The q span is widened by the r span
    // to absorb the axial shear.
    const invRow = 1 / (1.5 * cellR);
    const invCol = 1 / (SQRT3 * cellR);
    const rMin = Math.floor((oy - 0.5) * invRow) - 1;
    const rMax = Math.ceil((y1 - 0.5) * invRow) + 1;
    const qMin = Math.floor((ox - 0.5) * invCol - rMax / 2) - 1;
    const qMax = Math.ceil((x1 - 0.5) * invCol - rMin / 2) + 1;

    const fillR = cellR * 0.94;
    for (let r = rMin; r <= rMax; r++) {
      for (let q = qMin; q <= qMax; q++) {
        const wx = 0.5 + SQRT3 * cellR * (q + r / 2);
        const wy = 0.5 + 1.5 * cellR * r;
        if (wx < ox - cellR || wx > x1 + cellR || wy < oy - cellR || wy > y1 + cellR) continue;
        const host = this.workloadAt(wx, wy);
        if (!host) continue; // gap between workloads → leave empty
        // Honour the layer-0 inter-workload gap at depth too. That gap is made
        // by insetting each workload's merged outline (not by clearing cells),
        // so a sub-cell can still map to a host inside the inset band. Skip any
        // sub-cell whose centre lies outside the host's inset outline, so the
        // deep-zoom fill keeps exactly the same silhouette — and the same gaps —
        // as the layer-0 honeycomb.
        if (!pointInRings(wx, wy, host.outline)) continue;
        out.push({
          type: 'vector',
          rings: [hexPolygon(wx, wy, fillR)],
          fill: this.subCellColor(host, q, r, layer),
          layer: 1,
          depth: 0,
        });
      }
    }
  }

  /**
   * Colour of a layer-L sub-cell: the host workload's severity, textured by a
   * hash-picked resource and a small deterministic jitter so the fill reads as
   * many distinct cells rather than a flat wash.
   */
  private subCellColor(host: LiveWorkload, q: number, r: number, layer: number): RGBA {
    const h = hashCell(q, r, layer);
    let sev = host.crit;
    if (host.resources.length > 0) {
      sev = sev * 0.45 + host.resources[h % host.resources.length].current * 0.55;
    }
    const jitter = ((h >>> 8) / 0xffffff - 0.5) * 0.22;
    return this.critColor(clamp01(sev + jitter));
  }
}
