// HexGrid — a honeycomb workload monitor.
//
// Each workload occupies one or more hexagonal cells at a name-determined
// position (see placement.ts). Cell color encodes criticality (RdYlGn: green =
// healthy → red = critical); an active anomaly makes a workload pulse. Zooming
// past `firstLayerZoom` crosses into the metric layer, where a cell is replaced
// by one hexagon per metric that resource reports, while metric changes animate
// the colors smoothly in real time.

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
  hexSpiral,
  axialKey,
  spiralRadiusFor,
  type Axial,
} from './hex';
import { HexPlacer, placeHierarchical, placeDense, placeAffinity, type HierItem, type PlacedWorkload } from './placement';
import type { EntityUpdate, MonitorTarget } from '../../data/types';

export interface HexResourceInput {
  id: string;
  kind?: string;
  /** Severity 0..1 (0 = healthy, 1 = critical). */
  value: number;
}

export interface WorkloadInput {
  name: string;
  /** Stable identifier used to route live data updates. Defaults to `name`. */
  id?: string;
  /** Number of cells this workload spans. Default 1. */
  size?: number;
  /** Criticality 0..1 (0 = healthy, 1 = critical). */
  criticality: number;
  resources?: HexResourceInput[];
  meta?: Record<string, unknown>;
  /** Locality key: workloads sharing a group form one contiguous blob (with `placement: 'grouped'`). */
  group?: string;
  /** Group path coarse→fine (e.g. [mgmtGroup, subscription, resourceGroup]) for `placement: 'hierarchical'`. */
  groupPath?: string[];
  /** "Shared-ness" 0..1 for `placement: 'affinity'`: higher values (e.g. network) are pulled toward the centre of their cluster. */
  central?: number;
  /** Short glyph/code drawn inside the cell once it is large enough on screen (an in-cell "icon"). */
  label?: string;
  /** Categorical tint used when the grid's color mode is 'category'. */
  tint?: RGBA;
  /** Extra tooltip lines shown on hover (e.g. the resource's full path). */
  tooltip?: string[];
}

export interface HexGridOptions {
  workloads: WorkloadInput[];
  background?: RGBA;
  /** Exponential tween rate (1/s) for criticality + resource animation. */
  tweenRate?: number;
  /** Max integer tile zoom. Default 26. */
  maxZoom?: number;
  /** Placement strategy: 'hash' (default) scatters by name; 'grouped' clusters by `group`; 'hierarchical' packs by `groupPath` as bounding circles with gaps; 'dense' grows a gap-free territory map by `groupPath`; 'affinity' relaxes territories with a force-directed affinity model into an organic map. */
  placement?: 'hash' | 'grouped' | 'hierarchical' | 'dense' | 'affinity';
  /** Attraction weight per `groupPath` attribute position (leaf excluded) for 'affinity' placement. */
  affinityWeights?: number[];
  /** Gap (empty cells) between groups diverging at each `groupPath` level, coarsest first. Used by 'hierarchical'. */
  groupPads?: number[];
  /** Target footprint aspect ratio (width:height) for 'hierarchical'/'dense' placement. Default 16/9. */
  aspect?: number;
  /** Camera zoom at which the first finer sub-layer appears (semantic-zoom swap). Default 6. */
  firstLayerZoom?: number;
  /** Initial color mode: 'health' (live RdYlGn) or 'category' (static tint map). Default 'health'. */
  colorMode?: 'health' | 'category';
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
  /** Persistent RGBA the metric layer references, so a value change recolours
   *  in place instead of rebuilding the tile. */
  fillRGBA: RGBA;
}

/** One metric's hexagon inside its resource: world centre and radius. */
interface MetricCell {
  x: number;
  y: number;
  r: number;
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
  /** Persistent RGBA that the layer-0 health draw references, so live colour
   *  changes mutate this array in place (+markDirty) instead of rebuilding the
   *  whole estate's tiles every update. Alpha is fixed once at build time. */
  fillRGBA: RGBA;
  /** Persistent RGBA for the dimmed body drawn under the metric layer. */
  dimRGBA: RGBA;
  label?: string;
  tint: RGBA;
  tooltip?: string[];
  resources: LiveResource[];
  /** Metric cell layout, built on first deep-zoom draw. */
  metricCells?: MetricCell[];
}

const FIT_SPAN = 0.9;
// Semantic zoom. Layer 0 is the workload honeycomb: one cell per resource.
// Past `firstLayerZoom` the view crosses into the metric layer, where each
// resource cell is replaced by exactly as many hexagons as that resource
// actually reports metrics — no more, so nothing on screen is invented. There
// is only the one finer layer; zooming further just enlarges it.
const LAYER_SPAN = 5;
const DEFAULT_FIRST_LAYER_Z = 6;
const LABEL_PX = 54;
const PULSE_HALFLIFE = 1.6;
// 3D extrusion: each workload cell becomes a hex prism whose height (in units
// of the hex radius) encodes criticality — healthy = thin tile, critical = tall
// tower — with an extra spike while an anomaly pulses.
const HEIGHT_BASE = 0.25;
const HEIGHT_GAIN = 1.5;
const HEIGHT_PULSE = 0.75;
// Master switch for the 3D extrusion. While the focus is on shaping the 2D
// monitoring layout, keep this false so every cell renders as a flat hex tile
// (status still shown by colour); flip to true to bring back the towers.
const ENABLE_3D: boolean = false;
// Translucency for the workload prisms (see-through top + sides), and the
// inter-workload gap as a fraction of the hex radius. Lower alpha = more
// see-through; now that prisms are depth-sorted back-to-front by camera
// distance, a prism behind another stays visible instead of being covered.
const WORKLOAD_ALPHA = 0.5;
const GAP_FRAC = 0.08;
// Fraction of its radius each metric cell is drawn at, leaving a visible gap so
// a resource's metrics read as countable cells rather than one wash.
const METRIC_FILL = 0.86;
// On-screen diameter (px) at which a metric cell gets its name written in it.
const METRIC_LABEL_PX = 90;
// How much of its colour the resource cell keeps when it is drawn as the
// backdrop behind its own metrics — enough to show which cell they belong to,
// dim enough that the metrics stay the thing being read.
const BACKDROP_DIM = 0.34;
const HOT: RGBA = [1, 0.96, 0.75, 1];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Resolve the configured placement strategy into a name→placement lookup. */
function resolvePlacement(opts: HexGridOptions): Map<string, PlacedWorkload> {
  const hierItems = (): HierItem[] =>
    opts.workloads.map((w) => ({
      name: w.name,
      size: w.size ?? 1,
      path: w.groupPath ?? (w.group ? [w.group] : [w.name]),
      central: w.central,
    }));
  // A workload is identified by name everywhere downstream, so a repeated name
  // silently drops every cell but the last one's — worth saying out loud.
  const named = new Set(opts.workloads.map((w) => w.name));
  if (named.size !== opts.workloads.length) {
    console.warn(
      `HexGrid: ${opts.workloads.length - named.size} workloads share a name with another and will collapse.`,
    );
  }
  if (opts.placement === 'dense') {
    return new Map(placeDense(hierItems()).map((p) => [p.name, p]));
  }
  if (opts.placement === 'affinity') {
    const list = placeAffinity(hierItems(), { attrWeights: opts.affinityWeights });
    return new Map(list.map((p) => [p.name, p]));
  }
  if (opts.placement === 'hierarchical') {
    const list = placeHierarchical(hierItems(), opts.groupPads ?? [3, 1, 0], opts.aspect);
    return new Map(list.map((p) => [p.name, p]));
  }
  const placer = new HexPlacer(spiralRadiusFor(opts.workloads.length * 2 + 8));
  if (opts.placement === 'grouped') {
    const grouped = placer.placeGrouped(
      opts.workloads.map((w) => ({ name: w.name, size: w.size ?? 1, group: w.group ?? w.name })),
    );
    return new Map(grouped.map((p) => [p.name, p]));
  }
  return new Map(opts.workloads.map((w) => [w.name, placer.place(w.name, w.size ?? 1)]));
}

export class HexGrid extends VizBase implements MonitorTarget {
  private readonly workloads: LiveWorkload[] = [];
  private readonly byName = new Map<string, LiveWorkload>();
  /** Optional stable-id index (populated when a WorkloadInput sets `id`), so
   *  live data can address workloads by a backend id independent of the label. */
  private readonly byId = new Map<string, LiveWorkload>();
  private readonly cellToWorkload = new Map<string, number>();
  // Workloads whose criticality / pulse / resources are still tweening. onStep
  // only walks this set (typically a few hundred incidents) instead of every
  // cell in the estate, so an idle 50k-cell map costs almost nothing per frame.
  // Mutators (setCriticality / setResource / triggerAnomaly) enrol a workload;
  // onStep retires it once every value has settled on its target.
  private readonly activeWorkloads = new Set<LiveWorkload>();
  private readonly critStops: RGBA[];
  private readonly tweenRate: number;
  private readonly layerBaseZ: number;
  private colorMode: 'health' | 'category';
  private readonly neutralTint: RGBA = [0.5, 0.55, 0.62, 1];

  private fitScale = 1;
  private cxb = 0;
  private cyb = 0;
  private worldHexRadius = 0.02;
  private worldW = 1;
  private worldH = 1;
  private clock = 0;
  private fitted = false;
  // Uniform-grid spatial index (bins of workload indices by cell centre) so
  // layer-0 tiles scan only the nearby cells overlapping each tile.
  private gridN = 1;
  private gridBins: number[][] = [];
  // Zoom at which the whole estate fits the canvas (the far overview), plus the
  // clock of the last live-colour repaint — together they cap the repaint rate
  // only at the overview, where every visible cell repaints at once.
  private fitZoom = 0;
  private lastPaint = -1;

  constructor(canvas: HTMLCanvasElement, opts: HexGridOptions) {
    super({
      canvas,
      background: opts.background ?? [0.05, 0.06, 0.08, 1],
      minTileZ: 0,
      maxTileZ: opts.maxZoom ?? 26,
    });
    this.tweenRate = opts.tweenRate ?? 5;
    this.critStops = paletteStops('rdylgn');
    this.colorMode = opts.colorMode ?? 'health';
    this.layerBaseZ = (opts.firstLayerZoom ?? DEFAULT_FIRST_LAYER_Z) - LAYER_SPAN;

    // 1) Place every workload on the hex grid. 'grouped' keeps same-group
    // workloads in one contiguous blob (locality); 'hierarchical' additionally
    // separates groups by graduated gaps; 'dense' packs a gap-free territory
    // map; 'hash' scatters by name. (See resolvePlacement.)
    const byName = resolvePlacement(opts);
    const placed = opts.workloads.map((w) => ({ input: w, p: byName.get(w.name) as PlacedWorkload }));

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
    this.worldW = Math.max(1e-6, (maxX - minX) * this.fitScale);
    this.worldH = Math.max(1e-6, (maxY - minY) * this.fitScale);

    // 3) Build the live model.
    for (const { input, p } of placed) {
      if (p.cells.length === 0) continue; // grid exhausted for this workload
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
        fillRGBA: [0.5, 0.5, 0.5, 1],
        dimRGBA: [0.5, 0.5, 0.5, 1],
        label: input.label,
        tint: input.tint ?? this.neutralTint,
        tooltip: input.tooltip,
        resources: (input.resources ?? []).map((res) => ({
          id: res.id,
          kind: res.kind ?? 'resource',
          target: clamp01(res.value),
          current: clamp01(res.value),
          fillRGBA: this.critColor(clamp01(res.value)),
        })),
      };
      const idx = this.workloads.length;
      this.workloads.push(live);
      this.byName.set(live.name, live);
      if (input.id) this.byId.set(input.id, live);
      for (const [q, r] of p.cells) this.cellToWorkload.set(axialKey(q, r), idx);
    }

    // Index the placed cells for fast layer-0 tile culling.
    this.buildSpatialIndex();

    // The base ctor's first resize ran before worldW/worldH existed, so re-fit
    // now that the real footprint aspect is known (fit the bbox to the canvas).
    this.fitted = false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) this.onResize(rect.width, rect.height);

    this.start();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Set a workload's target criticality (animates). */
  setCriticality(name: string, value: number): void {
    const w = this.byName.get(name);
    if (w) {
      w.targetCrit = clamp01(value);
      this.activeWorkloads.add(w);
      this.scene.markDirty();
    }
  }

  /** Set a resource's target severity (animates). */
  setResource(name: string, id: string, value: number): void {
    const w = this.byName.get(name);
    if (!w) return;
    const res = w.resources.find((r) => r.id === id);
    if (res) {
      res.target = clamp01(value);
      this.activeWorkloads.add(w);
      this.scene.markDirty();
    }
  }

  /** Flash an anomaly pulse on a workload. */
  triggerAnomaly(name: string, intensity = 1): void {
    const w = this.byName.get(name);
    if (w) {
      w.pulse = Math.max(w.pulse, clamp01(intensity));
      this.activeWorkloads.add(w);
      this.scene.markDirty();
    }
  }

  /**
   * Apply a batch of live entity updates from a DataSource / MonitorFeed. Each
   * record is routed through the same animated paths as the individual setters
   * (criticality, resources, anomaly, tint), but the whole batch repaints once —
   * with no tile rebuilds — so a firehose of updates stays cheap even at 50k
   * cells. Records are addressed by `id` (falling back to the workload name), so
   * a backend can stream by stable id regardless of the display label.
   */
  applyUpdate(records: readonly EntityUpdate[]): void {
    let touched = false;
    for (const r of records) {
      const w = this.byId.get(r.id) ?? this.byName.get(r.id);
      if (!w) continue;
      if (r.severity !== undefined) {
        w.targetCrit = clamp01(r.severity);
        this.activeWorkloads.add(w);
        touched = true;
      }
      if (r.anomaly !== undefined && r.anomaly > 0) {
        w.pulse = Math.max(w.pulse, clamp01(r.anomaly));
        this.activeWorkloads.add(w);
        touched = true;
      }
      if (r.resources) {
        for (const ru of r.resources) {
          const res = w.resources.find((x) => x.id === ru.id);
          if (res) {
            res.target = clamp01(ru.value);
            this.activeWorkloads.add(w);
            touched = true;
          }
        }
      }
      if (r.tint !== undefined) w.tint = r.tint;
    }
    if (touched) this.scene.markDirty();
  }

  /** List placed workloads (for demo drivers). */
  listWorkloads(): WorkloadSummary[] {
    return this.workloads.map((w) => ({ name: w.name, size: w.cells.length }));
  }

  /** Switch between the live health palette and a static categorical territory map. */
  setColorMode(mode: 'health' | 'category'): void {
    this.colorMode = mode;
    this.invalidate();
    this.scene.markDirty();
  }

  /** Current color mode. */
  get colorModeName(): 'health' | 'category' {
    return this.colorMode;
  }

  /** Set a workload's categorical tint (shown when color mode is 'category'). */
  setTint(name: string, color: RGBA): void {
    const w = this.byName.get(name);
    if (w) w.tint = color;
  }

  // ── VizBase hooks ────────────────────────────────────────────────────────────

  protected override onStep(dt: number): boolean {
    this.clock += dt;
    const k = 1 - Math.exp(-this.tweenRate * dt);
    const decay = Math.pow(0.5, dt / PULSE_HALFLIFE);
    const health = this.colorMode === 'health';
    // Metric fills only need recolouring while the metric layer is on screen;
    // at the overview that would be a per-metric colour sample nobody sees.
    const metricsVisible = health && this.metricLayerVisible();
    // Tracks workloads whose layer-0 colour (criticality / pulse) actually
    // moved this step, so we only repaint when something visible changed.
    let colorChanged = false;
    let metricChanged = false;
    // Only the enrolled (still-tweening) workloads are walked — a settled estate
    // of 50k healthy cells has an empty-to-tiny set, so idle frames are free.
    for (const w of this.activeWorkloads) {
      let wColor = false;
      const d = w.targetCrit - w.crit;
      if (Math.abs(d) > 1e-4) {
        w.crit += d * k;
        wColor = true;
      } else {
        w.crit = w.targetCrit;
      }
      // Resources drive the metric layer's colours, so a moving value has to
      // repaint once the view is past the swap zoom — recoloured in place, same
      // as layer 0, so no tile is rebuilt.
      let resSettled = true;
      for (const res of w.resources) {
        const dd = res.target - res.current;
        if (Math.abs(dd) > 1e-4) {
          res.current += dd * k;
          resSettled = false;
          if (metricsVisible) {
            const c = this.critColor(res.current);
            res.fillRGBA[0] = c[0];
            res.fillRGBA[1] = c[1];
            res.fillRGBA[2] = c[2];
            metricChanged = true;
          }
        } else {
          res.current = res.target;
        }
      }
      if (w.pulse > 0.001) {
        w.pulse *= decay;
        wColor = true;
      } else {
        w.pulse = 0;
      }
      if (wColor) {
        colorChanged = true;
        // Live health colour: recolour this workload's shared fill array in
        // place. The cached layer-0 tile element references that same array, so
        // the next markDirty repaints the new colour with NO tile rebuild — this
        // is what keeps 50k live cells at the renderer's full redraw rate
        // instead of re-tessellating the whole estate a few times a second.
        if (health) this.updateHealthFill(w);
      } else if (resSettled) {
        // Criticality, pulse, and every resource have reached their targets:
        // retire the workload so it stops costing anything until it next moves.
        this.activeWorkloads.delete(w);
      }
    }
    // A categorical territory map is static — no redraw churn while the live
    // criticality keeps tweening underneath, so switching back resumes cleanly.
    if (!health) return false;
    // Both layers read fill arrays we just mutated, so a plain markDirty
    // repaints the live colours with zero tile rebuilds.
    const onLayer0 = !this.metricLayerVisible();
    if (onLayer0 ? colorChanged : metricChanged || colorChanged) {
      // At the far overview tens of thousands of cells repaint at once, which
      // can't fit in a single frame — so cap the live-colour repaint rate there
      // to keep the view responsive. Zoomed in (few cells on screen) repaint
      // every frame for a fully smooth animation.
      const overview = this.scene.camera.zoom < this.fitZoom + 2.5;
      if (!overview || this.clock - this.lastPaint >= 0.1) {
        this.lastPaint = this.clock;
        this.scene.markDirty();
      }
    }
    return false;
  }

  protected override onResize(w: number, h: number): void {
    if (!this.fitted && w > 1 && h > 1) {
      const cam = this.scene.camera;
      cam.centerX = 0.5;
      cam.centerY = 0.5;
      // Fit the honeycomb's world bounding box to the canvas (contain), so a
      // 16:9 layout fills a 16:9 monitor; the tighter axis sets the zoom.
      const fill = 0.94;
      const zW = Math.log2((w * fill) / (this.worldW * TILE_SIZE));
      const zH = Math.log2((h * fill) / (this.worldH * TILE_SIZE));
      cam.zoom = cam.zoomTarget = Math.max(
        this.minTileZ,
        Math.min(this.maxTileZ, Math.min(zW, zH)),
      );
      this.fitZoom = cam.zoom;
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

    // Layer 0 is one cell per resource; past the swap zoom the same area is
    // redrawn as that resource's metrics.
    const layer = Math.max(0, Math.floor((z - this.layerBaseZ) / LAYER_SPAN));
    if (layer === 0) {
      const cellPx = 2 * this.worldHexRadius * scale;
      this.drawLayer0(ox, oy, x1, y1, cellPx, out);
    } else {
      this.buildMetricLayer(ox, oy, x1, y1, scale, out);
    }
    return { z, x, y, elements: out };
  }

  /** Draw layer-0 workloads overlapping a tile rect, using the grid index. */
  private drawLayer0(
    ox: number,
    oy: number,
    x1: number,
    y1: number,
    cellPx: number,
    out: TileElement[],
  ): void {
    const G = this.gridN;
    const r = this.worldHexRadius;
    const cl = (v: number): number => (v < 0 ? 0 : v >= G ? G - 1 : v);
    const gx0 = cl(Math.floor((ox - r) * G));
    const gx1 = cl(Math.floor((x1 + r) * G));
    const gy0 = cl(Math.floor((oy - r) * G));
    const gy1 = cl(Math.floor((y1 + r) * G));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const bin = this.gridBins[gy * G + gx];
        for (let bi = 0; bi < bin.length; bi++) {
          const w = this.workloads[bin[bi]];
          if (w.bbox.maxx <= ox || w.bbox.minx >= x1 || w.bbox.maxy <= oy || w.bbox.miny >= y1) continue;
          this.drawWorkload(w, cellPx, out);
        }
      }
    }
  }

  /** True when the camera is deep enough that tiles draw the metric layer. */
  private metricLayerVisible(): boolean {
    return Math.floor(this.scene.camera.zoom) >= this.layerBaseZ + LAYER_SPAN;
  }

  /** Bucket workloads into a √N×√N grid by cell centre for fast tile culling. */
  private buildSpatialIndex(): void {
    const N = this.workloads.length;
    this.gridN = Math.max(1, Math.min(300, Math.round(Math.sqrt(N))));
    const G = this.gridN;
    const bins: number[][] = new Array(G * G);
    for (let b = 0; b < bins.length; b++) bins[b] = [];
    const cl = (v: number): number => (v < 0 ? 0 : v >= G ? G - 1 : v);
    for (let i = 0; i < N; i++) {
      const c = this.workloads[i].worldCenter;
      bins[cl(Math.floor(c[1] * G)) * G + cl(Math.floor(c[0] * G))].push(i);
    }
    this.gridBins = bins;
  }

  protected override hitTest(wx: number, wy: number, _z: number): TooltipData | null {
    const w = this.workloadAt(wx, wy);
    if (!w) return null;
    // Past the swap zoom the cursor is over one metric, not the whole resource.
    // Floor, not the caller's rounded zoom: that is how the viewport picks the
    // tiles on screen, and the tooltip has to agree with what is drawn.
    if (this.metricLayerVisible()) {
      const mi = this.metricAt(w, wx, wy);
      if (mi >= 0) {
        const res = w.resources[mi];
        const body = [`${(res.current * 100).toFixed(0)}% of threshold`];
        if (res.kind !== 'resource') body.push(res.kind);
        body.push(w.name);
        return { title: res.id, body };
      }
    }
    const sev = w.crit;
    const status = sev > 0.75 ? 'critical' : sev > 0.4 ? 'warning' : 'healthy';
    const body: string[] = [`status: ${status} (${(sev * 100).toFixed(0)}%)`];
    if (w.tooltip) body.push(...w.tooltip);
    if (w.resources.length > 0) {
      const worst = Math.max(...w.resources.map((r) => r.current));
      body.push(`worst metric: ${(worst * 100).toFixed(0)}%`);
    }
    if (w.pulse > 0.01) body.push('\u26a0 anomaly active');
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

  /** Recompute a workload's live health colour into its persistent fillRGBA in
   *  place (RGB only — alpha was fixed at build time), so a repaint needs no new
   *  allocation and, crucially, no tile rebuild. */
  private updateHealthFill(w: LiveWorkload): void {
    const base = this.critColor(w.crit);
    const lit = w.pulse > 0.001 ? this.applyPulse(base, w.pulse) : base;
    const f = w.fillRGBA;
    f[0] = lit[0];
    f[1] = lit[1];
    f[2] = lit[2];
    const d = w.dimRGBA;
    d[0] = lit[0] * BACKDROP_DIM;
    d[1] = lit[1] * BACKDROP_DIM;
    d[2] = lit[2] * BACKDROP_DIM;
  }

  /** Fill array for a workload's layer-0 body. In health mode this is the
   *  workload's persistent fillRGBA (shared with onStep, which recolours it in
   *  place so live updates never rebuild tiles); in category mode it's a fresh
   *  static colour, since a territory map doesn't animate. */
  private fillFor(w: LiveWorkload, lit: RGBA, category: boolean, alpha: number): RGBA {
    if (category) return [lit[0], lit[1], lit[2], alpha];
    const f = w.fillRGBA;
    f[0] = lit[0];
    f[1] = lit[1];
    f[2] = lit[2];
    f[3] = alpha;
    return f;
  }

  private critColor(severity: number): RGBA {
    return sampleStops(this.critStops, 1 - clamp01(severity));
  }

  private applyPulse(base: RGBA, pulse: number): RGBA {
    const osc = 0.5 + 0.5 * Math.sin(this.clock * 8);
    return interpolateRgb(base, HOT, clamp01(pulse) * osc * 0.75);
  }

  private drawWorkload(w: LiveWorkload, cellPx: number, out: TileElement[]): void {
    const category = this.colorMode === 'category';
    const base = category ? w.tint : this.critColor(w.crit);
    const lit = !category && w.pulse > 0.001 ? this.applyPulse(base, w.pulse) : base;

    // Cells of the same workload merge (no interior seam) while a gap separates
    // neighbouring workloads. With 3D on, each becomes an extruded prism whose
    // height encodes criticality; with 3D off, it stays a flat hex tile so the
    // monitoring wall reads as a clean 2D map (status shown by colour).
    let elevation = 0;
    if (ENABLE_3D) {
      const height = category
        ? this.worldHexRadius * HEIGHT_BASE
        : this.worldHexRadius * (HEIGHT_BASE + w.crit * HEIGHT_GAIN + w.pulse * HEIGHT_PULSE);
      elevation = height;
      const alpha = category ? 0.92 : WORKLOAD_ALPHA;
      const fill: RGBA = [lit[0], lit[1], lit[2], alpha];
      out.push({ type: 'extruded', rings: w.outline, height, fill, layer: 1, depth: 0 });
    } else if (w.cells.length === 1) {
      // Fast path: a single-cell workload is exactly one pointy-top hexagon, so
      // emit the instanced hexagon shape instead of a CPU-tessellated polygon
      // ring — this is what keeps tens of thousands of live cells fast.
      const rad = this.worldHexRadius * (1 - GAP_FRAC);
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x: w.worldCenter[0],
        y: w.worldCenter[1],
        w: 2 * rad,
        h: 2 * rad,
        fill: this.fillFor(w, lit, category, 1),
        layer: 1,
        depth: 0,
      });
    } else {
      out.push({
        type: 'vector',
        rings: w.outline,
        fill: this.fillFor(w, lit, category, 0.95),
        layer: 1,
        depth: 0,
      });
    }

    if (cellPx >= LABEL_PX) {
      out.push({
        type: 'text',
        x: w.worldCenter[0],
        y: w.worldCenter[1],
        size: 11,
        text: w.label ?? w.name,
        color: [0.96, 0.98, 1, 1],
        align: 'center',
        floating: true,
        elevation,
        layer: 3,
        depth: 0,
      });
    }
  }

  /**
   * Metric layer: draw one hexagon per metric for every resource overlapping
   * the tile. The cells are a hex spiral centred on the resource, scaled so the
   * whole spiral fits the area the resource occupies at layer 0 — so a resource
   * with three metrics shows three large cells and one with ten shows ten small
   * ones. The count is the data's, never padded to fill the hexagon.
   */
  private buildMetricLayer(
    ox: number,
    oy: number,
    x1: number,
    y1: number,
    scale: number,
    out: TileElement[],
  ): void {
    const category = this.colorMode === 'category';
    const G = this.gridN;
    const r = this.worldHexRadius;
    const cl = (v: number): number => (v < 0 ? 0 : v >= G ? G - 1 : v);
    const gx0 = cl(Math.floor((ox - r) * G));
    const gx1 = cl(Math.floor((x1 + r) * G));
    const gy0 = cl(Math.floor((oy - r) * G));
    const gy1 = cl(Math.floor((y1 + r) * G));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const bin = this.gridBins[gy * G + gx];
        for (let bi = 0; bi < bin.length; bi++) {
          const w = this.workloads[bin[bi]];
          if (w.bbox.maxx <= ox || w.bbox.minx >= x1 || w.bbox.maxy <= oy || w.bbox.miny >= y1) continue;
          this.drawMetrics(w, ox, oy, x1, y1, scale, category, out);
        }
      }
    }
  }

  private drawMetrics(
    w: LiveWorkload,
    ox: number,
    oy: number,
    x1: number,
    y1: number,
    scale: number,
    category: boolean,
    out: TileElement[],
  ): void {    const cells = this.metricLayout(w);
    if (cells.length === 0) return;
    // The resource's own body, dimmed, sits under its metrics so it stays
    // visible which cell they belong to and where one resource ends. Emitted
    // only from the tile holding its centre: elements are not clipped to their
    // tile, so a second copy would paint over metric cells already drawn by a
    // neighbouring tile.
    const cx = w.worldCenter[0];
    const cy = w.worldCenter[1];
    if (cx >= ox && cx < x1 && cy >= oy && cy < y1) this.drawBackdrop(w, category, out);
    const labelPx = 2 * cells[0].r * METRIC_FILL * scale;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.x + c.r <= ox || c.x - c.r >= x1 || c.y + c.r <= oy || c.y - c.r >= y1) continue;
      const res = w.resources[i];
      const rad = c.r * METRIC_FILL;
      let fill: RGBA;
      if (category) {
        fill = w.tint;
      } else {
        // Seed here too: onStep only recolours while this layer is on screen.
        const base = this.critColor(res.current);
        fill = res.fillRGBA;
        fill[0] = base[0];
        fill[1] = base[1];
        fill[2] = base[2];
      }
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x: c.x,
        y: c.y,
        w: 2 * rad,
        h: 2 * rad,
        fill,
        layer: 1,
        depth: 0,
      });
      if (labelPx >= METRIC_LABEL_PX) {
        out.push({
          type: 'text',
          x: c.x,
          y: c.y,
          size: 10,
          text: res.id,
          color: [0.98, 0.99, 1, 1],
          align: 'center',
          floating: true,
          layer: 3,
          depth: 0,
        });
      }
    }
  }

  /** The resource's layer-0 silhouette, dimmed, drawn beneath its metrics. */
  private drawBackdrop(w: LiveWorkload, category: boolean, out: TileElement[]): void {
    let fill: RGBA;
    if (category) {
      fill = [w.tint[0] * BACKDROP_DIM, w.tint[1] * BACKDROP_DIM, w.tint[2] * BACKDROP_DIM, 1];
    } else {
      // Seed the shared array here, as layer 0 does, so a resource that has not
      // tweened yet is still drawn in its real colour.
      const base = this.critColor(w.crit);
      fill = w.dimRGBA;
      fill[0] = base[0] * BACKDROP_DIM;
      fill[1] = base[1] * BACKDROP_DIM;
      fill[2] = base[2] * BACKDROP_DIM;
    }
    if (w.cells.length === 1) {
      const rad = this.worldHexRadius * (1 - GAP_FRAC);
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x: w.worldCenter[0],
        y: w.worldCenter[1],
        w: 2 * rad,
        h: 2 * rad,
        fill,
        layer: 1,
        depth: 0,
      });
    } else {
      out.push({ type: 'vector', rings: w.outline, fill, layer: 1, depth: 0 });
    }
  }

  /**
   * Positions for a resource's metric cells, computed once. A spiral of `n`
   * hexes spans `spiralRadiusFor(n)` rings, so sizing the sub-hex to
   * fit / (rings·√3 + 1) puts the outermost cell exactly inside the area the
   * resource covers at layer 0.
   */
  private metricLayout(w: LiveWorkload): MetricCell[] {
    if (w.metricCells) return w.metricCells;
    const n = w.resources.length;
    const cells: MetricCell[] = [];
    if (n > 0) {
      // Equal-area circle of the resource's cells, inset by the layer-0 gap.
      const fit = this.worldHexRadius * (1 - GAP_FRAC) * 0.866 * Math.sqrt(w.cells.length);
      const rings = spiralRadiusFor(n);
      const subR = fit / (rings * Math.sqrt(3) + 1);
      const spiral = hexSpiral(rings);
      for (let i = 0; i < n; i++) {
        const [dq, dr] = spiral[i];
        const [dx, dy] = axialToPixel(dq, dr, subR);
        cells.push({ x: w.worldCenter[0] + dx, y: w.worldCenter[1] + dy, r: subR });
      }
    }
    w.metricCells = cells;
    return cells;
  }

  /** The metric cell under a world point, or -1. */
  private metricAt(w: LiveWorkload, wx: number, wy: number): number {
    const cells = this.metricLayout(w);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const dx = wx - c.x;
      const dy = wy - c.y;
      if (dx * dx + dy * dy <= c.r * c.r) return i;
    }
    return -1;
  }
}
