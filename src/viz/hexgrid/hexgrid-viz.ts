// HexGrid — a honeycomb workload monitor.
//
// Each workload occupies one or more hexagonal cells at a name-determined
// position (see placement.ts). Cell color encodes criticality (the `status`
// ramp: deep emerald = healthy → vivid rose = critical); an active anomaly makes
// a workload pulse. Zooming crosses into the next semantic layer every few zoom
// levels, replacing each cell with a finer honeycomb that fills it
// (self-similar), while metric changes animate the colors smoothly in real time.

import { VizBase } from '../viz-base';
import type { TileJSON, TileElement, ShapeElement, VectorElement } from '../../core/tile';
import { TILE_SIZE } from '../../core/constants';
import type { RGBA } from '../../core/types';
import type { TooltipData } from '../tooltip';
import {
  BACKGROUND,
  HAIRLINE,
  HOT,
  INK,
  NEUTRAL,
  NEUTRAL_LIGHT,
  categorical,
  hexToRgba,
  interpolateRgb,
  paletteStops,
  sampleStops,
} from '../../color';
import {
  fitLabel,
  labelCapacity,
  labelColorFor,
  labelWorldSize,
  LABEL_FONT,
  LABEL_MIN_CELL_PX,
  LABEL_TRACKING,
} from './label';
import {
  axialToPixel,
  pixelToAxial,
  hexRound,
  hexPolygon,
  axialKey,
  spiralRadiusFor,
  type Axial,
} from './hex';
import {
  HexPlacer,
  hashString,
  placeHierarchical,
  placeDense,
  placeAffinity,
  placeRelational,
  placementKey,
  restorePlacement,
  serializePlacement,
  type HierItem,
  type PlacedWorkload,
  type PlacementSnapshot,
  type RelItem,
} from './placement';
import { placeForce } from './force-layout';
import type { EntityUpdate, MonitorTarget } from '../../data/types';
export interface HexResourceInput {
  id: string;
  kind?: string;
  /** Severity 0..1 (0 = healthy, 1 = critical). */
  value: number;
}

/**
 * One link to another resource: a bare name when every relationship looks the
 * same, or `{ id, kind }` to have that link drawn in its kind's own style — a
 * VNet peering, a disk attachment and a private endpoint are not the same fact
 * about the estate, and the wires say so (see `HexGridOptions.linkStyles`).
 */
export type ResourceLink = string | { id: string; kind?: string };

/** How links of one kind are drawn. */
export interface LinkStyle {
  /** Wire colour; its alpha is the wire's opacity. */
  color: RGBA;
  /** Multiplier on the base wire thickness. Default 1. */
  width?: number;
}

/** Resolve a link to the name it points at. */
function linkId(l: ResourceLink): string {
  return typeof l === 'string' ? l : l.id;
}

export interface WorkloadInput {
  name: string;
  /** Stable identifier used to route live data updates. Defaults to `name`. */
  id?: string;
  /** Number of cells this workload spans. Default 1. */
  size?: number;
  /** Criticality 0..1 (0 = healthy, 1 = critical). */
  criticality: number;
  /** False for resources no health is reported for (pure config: VNet, NIC, NSG, disk …) — drawn neutral and ignored by aggregate status. Default true. */
  monitored?: boolean;
  resources?: HexResourceInput[];
  meta?: Record<string, unknown>;
  /** Locality key: workloads sharing a group form one contiguous blob (with `placement: 'grouped'`). */
  group?: string;
  /** Group path coarse→fine (e.g. [mgmtGroup, subscription, resourceGroup]) for `placement: 'hierarchical'`. */
  groupPath?: string[];
  /** "Shared-ness" 0..1 for `placement: 'affinity'`: higher values (e.g. network) are pulled toward the centre of their cluster. */
  central?: number;
  /** Names of related resources for `placement: 'relational'` — the magnetic links that arrange a cluster's contents. Tag a link with a `kind` to have it drawn in that kind's style. */
  deps?: ResourceLink[];
  /** Non-containment attributes (e.g. [region, workload]) whose siblings attract, for `placement: 'relational'`. */
  affinity?: string[];
  /** A key shared with the clusters this one should gather near — the Virtual WAN hub a subscription peers with, for `placement: 'force'`. */
  anchor?: string;
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
  /** Placement strategy: 'hash' (default) scatters by name; 'grouped' clusters by `group`; 'hierarchical' packs by `groupPath` as bounding circles with gaps; 'dense' grows a gap-free territory map by `groupPath`; 'affinity' relaxes territories with a force-directed affinity model into an organic map; 'relational' nests `groupPath` as walled clusters and arranges each one by its `deps` links; 'force' settles the whole containment tree under graded cohesion, dependency and hub forces. */
  placement?: 'hash' | 'grouped' | 'hierarchical' | 'dense' | 'affinity' | 'relational' | 'force';
  /** Attraction weight per `groupPath` attribute position (leaf excluded) for 'affinity' placement, or per `affinity` slot for 'relational'. */
  affinityWeights?: number[];
  /** Cohesion per containment depth (coarsest first) for 'force': how hard each level holds its children together. */
  cohesion?: number[];
  /** Pull between clusters that depend on each other ('force'). */
  linkK?: number;
  /** Pull between clusters sharing an `anchor` — the same hub ('force'). */
  anchorK?: number;
  /** Empty-cell gap ringing a cluster at each `groupPath` depth (coarsest first) for 'relational' placement. */
  moats?: number[];
  /** A layout baked earlier: reused when it still matches the inputs, ignored otherwise. Laying out a large estate costs seconds, and reusing it also keeps the map still as resources come and go. */
  layout?: PlacementSnapshot | null;
  /** Handed a freshly computed layout so the app can persist it. */
  onLayout?: (snap: PlacementSnapshot) => void;
  /** Gap (empty cells) between groups diverging at each `groupPath` level, coarsest first. Used by 'hierarchical'. */
  groupPads?: number[];
  /** Target footprint aspect ratio (width:height) for 'hierarchical'/'dense' placement. Default 16/9. */
  aspect?: number;
  /** Camera zoom at which the first finer sub-layer appears (semantic-zoom swap). Default 6. */
  firstLayerZoom?: number;
  /** Fold each subscription into one glyph when zoomed out past the cell layer. Default true. */
  aggregate?: boolean;
  /** Initial color mode: 'health' (live status ramp) or 'category' (static tint map). Default 'health'. */
  colorMode?: 'health' | 'category';
  /** Show what belongs with what once cells read individually: a shared bed under each cluster, then wires along the `deps` links. Default true. */
  relations?: boolean;
  /** Hover focus: dim everything but the cell under the pointer, what it is wired to, and the wires between them. Default false — with it on, every cell the pointer crosses redraws the map. */
  focusMode?: boolean;
  /** Colour and thickness per `deps` kind. Kinds with no entry fall back to a plain hairline. */
  linkStyles?: Record<string, LinkStyle>;
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
  /** Persistent RGBA that the layer-0 health draw references, so live colour
   *  changes mutate this array in place (+markDirty) instead of rebuilding the
   *  whole estate's tiles every update. Alpha is fixed once at build time. */
  fillRGBA: RGBA;
  /** Layer-0 body element, built once and shared by every tile and zoom level
   *  showing this cell. A zoom-level change re-emits every visible cell, so one
   *  fresh element per cell per rebuild is what turns that into a stall. */
  body?: ShapeElement | VectorElement;
  label?: string;
  tint: RGBA;
  tooltip?: string[];
  resources: LiveResource[];
  /** Containment path (coarse→fine) used to bucket cells into zoom-out aggregates. */
  groupPath?: string[];
  /** False when no health is reported for this resource (see WorkloadInput.monitored). */
  monitored: boolean;
  /** Position in `workloads` — a link is drawn by its lower-indexed end only. */
  index: number;
  /** Resources this one is wired to — `deps` resolved to both ends of each link. */
  links?: { to: LiveWorkload; kind?: string }[];
  /** Bed colour shared by every cell of the same finest containment cluster. */
  bedColor?: RGBA;
  /** Cached bed hexagons, faded-out cells and link wires. Like `body`, built on
   *  the first close-up draw and then shared by every tile and zoom level. */
  bed?: ShapeElement[];
  dim?: ShapeElement[];
  /** Fill behind `dim`: this cell's own colour faded toward the background. */
  dimRGBA?: RGBA;
  wires?: VectorElement[];
  wiresFaint?: VectorElement[];
}

/**
 * A zoom-out aggregate: one subscription's worth of cells collapsed to a single
 * hexagon glyph. Drawn as an instanced `shape` (O(1) repack) — not a tessellated
 * polygon — so the far overview costs a few hundred instances instead of tens of
 * thousands of cells. Its colour is the members' worst-case health, recoloured
 * in place so a live update needs no tile rebuild.
 */
interface Aggregate {
  center: [number, number];
  radius: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  members: LiveWorkload[];
  count: number;
  label: string;
  worstCrit: number;
  /** True when at least one member reports health at all. */
  monitored: boolean;
  fillRGBA: RGBA;
  /** Static categorical tint (category colour mode). */
  tint: RGBA;
}

const FIT_SPAN = 0.9;
// Semantic-zoom layers. Every LAYER_SPAN zoom levels the current honeycomb is
// replaced by the next finer layer, whose cells subdivide each parent cell by
// LAYER_SUBDIV = 2^LAYER_SPAN (linear). That power-of-two keeps the zoom
// self-similar: the incoming layer's cells appear at exactly the on-screen size
// the parent layer had LAYER_SPAN levels earlier. The first swap lands on
// `firstLayerZoom` (default below); raising it delays the finer layer so fewer,
// larger sub-cells appear (cheaper) when it finally kicks in.
const LAYER_SPAN = 5;
const LAYER_SUBDIV = 2 ** LAYER_SPAN;
const DEFAULT_FIRST_LAYER_Z = 6;
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
// Fraction of its radius each sub-layer cell is drawn at, leaving a gap between
// adjacent cells. Reused as the coarser-layer core radius when nesting gaps.
const SUB_FILL = 0.94;
// Resources Azure Resource Health reports nothing about (VNet, NIC, NSG, disk,
// private endpoint …) still shape the map — they are the scaffolding everything
// else attaches to — so they are drawn in a muted neutral rather than being
// coloured as if they were healthy.
const UNMONITORED: RGBA = NEUTRAL;
// Relationship cues, switched on as the cells grow big enough to be read one by
// one. The bed is a full-size hexagon under each cell tinted by its cluster, so
// a resource group's cells sit on one continuous slab with the moat around it
// left as background; the wires trace the `deps` links that arranged those cells
// in the first place (a NIC to its VM, a private endpoint to the database it
// fronts). Beds come first — one extra instance per cell — and the wires follow
// a couple of zoom levels later, where few enough are on screen to stay legible.
const BED_MIN_CELL_PX = 16;
// Wires arrive in two steps. From WIRE_MIN_CELL_PX every link is a
// screen-constant hairline — thin and faint enough that a whole estate's wiring
// reads as texture rather than noise — and from WIRE_FULL_CELL_PX the wires
// thicken with the cells and take their kind's full colour.
const WIRE_MIN_CELL_PX = 6;
const WIRE_FULL_CELL_PX = 40;
/** Hairline width (screen px), and the share of a kind's opacity it keeps. */
const WIRE_FAINT_PX = 1;
const WIRE_FAINT_ALPHA = 0.5;
/** How far a bed is tinted from the background toward its cluster's hue. */
const BED_MIX = 0.28;
const BED_HUE = categorical('aurora');
/** Bed tint used while the cells carry a categorical colour of their own: a
 *  plain slate, so the bed still marks out the cluster without arguing with the
 *  hues on top of it. */
const BED_NEUTRAL: RGBA = NEUTRAL_LIGHT;
const WIRE_COLOR: RGBA = HAIRLINE;
/** Base wire thickness (cell radii) for an unstyled link, and the clearance
 *  kept at each end. A kind's `width` multiplies the thickness. */
const WIRE_WIDTH = 0.06;
const WIRE_TRIM = 0.55;
/** Beyond this span (cell pitches) a link is drawn as two halves, one from each
 *  end. A spoke VNet's peering to its region's Virtual WAN hub crosses the map,
 *  and whichever end you are looking at, the other one is far outside the loaded
 *  tiles — so each end draws its own half, which also keeps the halves from
 *  overlapping and doubling the opacity where they meet. */
const WIRE_SPLIT_SPAN = 3.5;
/** The hovered cell's wires keep their kind's colour but go fully opaque and
 *  this much thicker, so they read as "these are the links you asked for". */
const FOCUS_WIRE_GAIN = 1.7;
/** While a cell is hovered, every unrelated cell keeps this much of its own
 *  colour and fades the rest of the way into the background, so only that cell,
 *  what it is wired to, and the wires between them stand out. */
const DIM_MIX = 0.18;
/** Ring drawn behind the hovered cell (cell radii) to anchor the focus. */
const FOCUS_RING = 1.12;
const FOCUS_RING_COLOR: RGBA = hexToRgba(INK.accent);
const DEFAULT_BG: RGBA = BACKGROUND;
const NO_WIRES: VectorElement[] = [];
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

/**
 * Exact containment test for a pointy-top regular hexagon of circumradius `R`
 * centred at the origin: the hexagon is the intersection of three edge slabs
 * (normals at 0°/60°/120°), each of half-width = inradius = R·√3/2. Used to
 * detect a coarser sub-layer's inter-cell gap when nesting the honeycomb gaps.
 */
function inHexCore(dx: number, dy: number, R: number): boolean {
  const k = R * 0.8660254037844386; // inradius = R·√3/2
  return (
    Math.abs(dx) <= k &&
    Math.abs(0.5 * dx + 0.8660254037844386 * dy) <= k &&
    Math.abs(-0.5 * dx + 0.8660254037844386 * dy) <= k
  );
}

/** Small deterministic hash of a sub-cell (q, r, layer) → uint32. */
function hashCell(q: number, r: number, layer: number): number {
  let h = (2166136261 ^ (q * 374761393) ^ (r * 668265263) ^ (layer * 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return (h ^ (h >>> 13)) >>> 0;
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
  if (opts.placement === 'dense') {
    return new Map(placeDense(hierItems()).map((p) => [p.name, p]));
  }
  if (opts.placement === 'affinity') {
    const list = placeAffinity(hierItems(), { attrWeights: opts.affinityWeights });
    return new Map(list.map((p) => [p.name, p]));
  }
  if (opts.placement === 'force') {
    const rel: RelItem[] = opts.workloads.map((w) => ({
      name: w.name,
      size: w.size ?? 1,
      path: w.groupPath ?? (w.group ? [w.group] : [w.name]),
      deps: w.deps?.map(linkId),
      central: w.central,
      affinity: w.anchor ? [w.anchor] : undefined,
    }));
    const key = placementKey(rel, { moats: opts.moats }, 'force');
    const cached = restorePlacement(opts.layout, rel, key);
    const list =
      cached ??
      placeForce(
        opts.workloads.map((w) => ({
          name: w.name,
          size: w.size ?? 1,
          path: w.groupPath ?? (w.group ? [w.group] : [w.name]),
          deps: w.deps?.map(linkId),
          central: w.central,
          anchor: w.anchor,
        })),
        {
          cohesion: opts.cohesion,
          linkK: opts.linkK,
          anchorK: opts.anchorK,
          moats: opts.moats,
        },
      );
    if (cached === null) opts.onLayout?.(serializePlacement(list, key));
    return new Map(list.map((p) => [p.name, p]));
  }
  if (opts.placement === 'relational') {
    const rel: RelItem[] = opts.workloads.map((w) => ({
      name: w.name,
      size: w.size ?? 1,
      path: w.groupPath ?? (w.group ? [w.group] : [w.name]),
      deps: w.deps?.map(linkId),
      central: w.central,
      affinity: w.affinity,
    }));
    const relOpts = { moats: opts.moats, affinityWeights: opts.affinityWeights };
    const key = placementKey(rel, relOpts);
    const cached = restorePlacement(opts.layout, rel, key);
    const list = cached ?? placeRelational(rel, relOpts);
    if (cached === null) opts.onLayout?.(serializePlacement(list, key));
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
  private readonly neutralTint: RGBA = NEUTRAL_LIGHT;

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
  // Zoom-out aggregates (one hexagon per subscription) plus a lookup from a
  // cell's subscription prefix to its aggregate, for hover/click at the
  // overview. Empty when workloads carry no groupPath (aggregation disabled).
  private aggregates: Aggregate[] = [];
  private readonly aggByKey = new Map<string, Aggregate>();
  private aggPrefixLen = 0;
  private readonly aggEnabled: boolean;
  // Close-up relationship cues: whether they are on, the clear colour they are
  // mixed from, one bed colour per containment cluster, the per-kind wire styles
  // (resolved per tier into `linkStyleCache`), and the hovered cell, whose links
  // are drawn in full.
  private relations: boolean;
  private focusMode: boolean;
  private readonly bg: RGBA;
  private readonly bedColors = new Map<string, RGBA>();
  private readonly linkStyles: Record<string, LinkStyle>;
  private readonly linkStyleCache = new Map<string, { color: RGBA; width: number }>();
  private readonly hiddenKinds = new Set<string>();
  /** The hovered cell together with everything it is wired to — what stays lit
   *  while the rest of the map fades out. Null when nothing is hovered. */
  private focusSet: Set<LiveWorkload> | null = null;
  private focus: LiveWorkload | null = null;

  constructor(canvas: HTMLCanvasElement, opts: HexGridOptions) {
    super({
      canvas,
      background: opts.background ?? DEFAULT_BG,
      minTileZ: 0,
      maxTileZ: opts.maxZoom ?? 26,
    });
    this.tweenRate = opts.tweenRate ?? 5;
    this.critStops = paletteStops('status');
    this.colorMode = opts.colorMode ?? 'health';
    this.layerBaseZ = (opts.firstLayerZoom ?? DEFAULT_FIRST_LAYER_Z) - LAYER_SPAN;
    this.aggEnabled = opts.aggregate !== false;
    this.relations = opts.relations !== false;
    this.focusMode = opts.focusMode === true;
    this.linkStyles = opts.linkStyles ?? {};
    this.bg = opts.background ?? DEFAULT_BG;

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
        index: this.workloads.length,
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
        label: input.label,
        tint: input.tint ?? this.neutralTint,
        tooltip: input.tooltip,
        groupPath: input.groupPath,
        bedColor: this.bedColorFor(input.groupPath),
        monitored: input.monitored !== false,
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
      if (input.id) this.byId.set(input.id, live);
      for (const [q, r] of p.cells) this.cellToWorkload.set(axialKey(q, r), idx);
    }

    // Resolve the dependency links now that every workload exists.
    this.buildRelations(placed);
    // Index the placed cells for fast layer-0 tile culling.
    this.buildSpatialIndex();
    // Pre-compute the zoom-out aggregates (one hexagon per subscription).
    this.buildAggregates();

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
    this.refreshBedColors();
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

  /** Turn the close-up relationship cues (cluster beds + link wires) on or off. */
  setRelations(on: boolean): void {
    if (this.relations === on) return;
    this.relations = on;
    this.invalidate();
    this.scene.markDirty();
  }

  /** Show or hide every link of one `deps` kind. */
  setLinkKindVisible(kind: string, visible: boolean): void {
    if (visible === !this.hiddenKinds.has(kind)) return;
    if (visible) this.hiddenKinds.delete(kind);
    else this.hiddenKinds.add(kind);
    // Wires are baked per cell, so the cached sets have to go with the change.
    for (const w of this.workloads) {
      w.wires = undefined;
      w.wiresFaint = undefined;
    }
    this.rebuildFocusSet();
    this.invalidate();
    this.scene.markDirty();
  }

  /** Link kinds currently hidden. */
  get hiddenLinkKinds(): string[] {
    return [...this.hiddenKinds];
  }

  /** Turn hover focus on or off: with it on, hovering a cell fades out
   *  everything it is not wired to. */
  setFocusMode(on: boolean): void {
    if (this.focusMode === on) return;
    this.focusMode = on;
    if (!on) this.setFocus(null);
  }

  /** Whether hover focus is on. */
  get focusModeOn(): boolean {
    return this.focusMode;
  }

  /** Whether the close-up relationship cues are on. */
  get relationsShown(): boolean {
    return this.relations;
  }

  // ── VizBase hooks ────────────────────────────────────────────────────────────

  protected override onStep(dt: number): boolean {
    this.clock += dt;
    const k = 1 - Math.exp(-this.tweenRate * dt);
    const decay = Math.pow(0.5, dt / PULSE_HALFLIFE);
    const health = this.colorMode === 'health';
    // Tracks workloads whose layer-0 colour (criticality / pulse) actually
    // moved this step, so we only repaint when something visible changed.
    let colorChanged = false;
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
      // Resources tween for deep-zoom sub-cell fills and tooltips; they don't
      // drive the layer-0 colour, so they don't force a repaint on their own —
      // but they DO keep a workload enrolled until they settle.
      let resSettled = true;
      for (const res of w.resources) {
        const dd = res.target - res.current;
        if (Math.abs(dd) > 1e-4) {
          res.current += dd * k;
          resSettled = false;
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
    // Layer 0 reads the shared fill arrays we just mutated, so a plain markDirty
    // repaints the live colours with zero tile rebuilds. Deeper sub-layers use
    // procedural per-sub-cell fills (effectively static), so leave them alone.
    if (colorChanged && this.scene.camera.zoom < this.layerBaseZ + LAYER_SPAN) {
      // When the overview is showing aggregates, refresh their worst-case colour
      // from the members that just tweened (a few hundred writes) so the
      // subscription glyphs carry live health too.
      if (this.aggLevelForZoom(this.scene.camera.zoom) > 0) this.recolorAggregates();
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

    // Which semantic layer this tile zoom belongs to: 0 is the workload
    // honeycomb, deeper layers are progressively finer sub-cell fills.
    const layer = Math.max(0, Math.floor((z - this.layerBaseZ) / LAYER_SPAN));
    if (layer === 0 && this.aggLevelForZoom(z) > 0) {
      // Far overview: one hexagon per subscription instead of every single cell.
      this.drawAggregates(ox, oy, x1, y1, scale, out);
    } else if (layer === 0) {
      const cellPx = 2 * this.worldHexRadius * scale;
      this.drawLayer0(ox, oy, x1, y1, cellPx, out);
    } else {
      this.buildSubLayer(layer, ox, oy, x1, y1, out);
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
          // A cell straddling a tile edge is drawn by both tiles — harmless for
          // its opaque body, but a translucent wire drawn twice would come out
          // darker, so wires are left to the tile holding the cell's centre.
          const c = w.worldCenter;
          const owns = c[0] >= ox && c[0] < x1 && c[1] >= oy && c[1] < y1;
          this.drawWorkload(w, cellPx, out, owns);
        }
      }
    }
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

  // ── Zoom-out aggregation ────────────────────────────────────────

  /**
   * Bucket every resource into its subscription (the groupPath minus its finest
   * level) and collapse each bucket to one Aggregate. Only that level is
   * aggregated: a coarser worst-case saturates to red — every management group
   * has *something* broken — and stops saying anything, while a per-subscription
   * worst-case stays local, so the overview reads as a calm field with faults
   * where the faults actually are. A no-op when there is no hierarchy to fold.
   */
  private buildAggregates(): void {
    this.aggregates = [];
    this.aggByKey.clear();
    if (!this.aggEnabled) {
      this.aggPrefixLen = 0;
      return;
    }
    let maxLen = 0;
    for (const w of this.workloads) {
      if (w.groupPath && w.groupPath.length > maxLen) maxLen = w.groupPath.length;
    }
    if (maxLen < 2) {
      this.aggPrefixLen = 0;
      return;
    }
    const p = maxLen - 1;
    this.aggPrefixLen = p;
    const groups = new Map<string, LiveWorkload[]>();
    for (const w of this.workloads) {
      const path = w.groupPath;
      if (!path || path.length < 2) continue;
      const key = path.slice(0, p).join('\u0001');
      const g = groups.get(key);
      if (g) g.push(w);
      else groups.set(key, [w]);
    }
    for (const [key, members] of groups) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const w of members) {
        const n = w.cells.length;
        sx += w.worldCenter[0] * n;
        sy += w.worldCenter[1] * n;
        count += n;
        if (w.bbox.minx < minx) minx = w.bbox.minx;
        if (w.bbox.miny < miny) miny = w.bbox.miny;
        if (w.bbox.maxx > maxx) maxx = w.bbox.maxx;
        if (w.bbox.maxy > maxy) maxy = w.bbox.maxy;
      }
      const cx = count > 0 ? sx / count : 0;
      const cy = count > 0 ? sy / count : 0;
      // √area, so the glyph roughly covers the cells it stands in for.
      const radius = this.worldHexRadius * Math.max(1, Math.sqrt(count)) * 0.9;
      const path0 = members[0].groupPath as string[];
      const agg: Aggregate = {
        center: [cx, cy],
        radius,
        bbox: { minx, miny, maxx, maxy },
        members,
        count,
        label: path0[p - 1] ?? path0[path0.length - 1] ?? '',
        worstCrit: 0,
        monitored: members.some((m) => m.monitored),
        fillRGBA: [0.5, 0.5, 0.5, 1],
        tint: members[0].tint,
      };
      this.aggregates.push(agg);
      this.aggByKey.set(key, agg);
    }
    this.recolorAggregates();
  }

  /** Which aggregate level to draw at tile-zoom `z`: 1 (subscription glyphs)
   *  below the first cell layer, or -1 (individual cells) at or above it. */
  private aggLevelForZoom(z: number): number {
    if (this.aggregates.length === 0 || z >= this.layerBaseZ) return -1;
    return 1;
  }

  /** Refresh every aggregate's worst-case health colour from its members, in
   *  place (RGB only), so a repaint needs no tile rebuild. */
  private recolorAggregates(): void {
    for (const a of this.aggregates) {
      let worst = 0;
      let pulse = 0;
      for (const w of a.members) {
        // Config-only resources report nothing, so they can't set the status.
        if (!w.monitored) continue;
        if (w.crit > worst) worst = w.crit;
        if (w.pulse > pulse) pulse = w.pulse;
      }
      a.worstCrit = worst;
      const base = a.monitored ? this.critColor(worst) : UNMONITORED;
      const lit = pulse > 0.001 ? this.applyPulse(base, pulse) : base;
      const f = a.fillRGBA;
      f[0] = lit[0];
      f[1] = lit[1];
      f[2] = lit[2];
    }
  }

  /** Draw the subscription aggregates overlapping a tile rect as instanced
   *  hexagons, labelling them once the glyph is large enough on screen. */
  private drawAggregates(
    ox: number,
    oy: number,
    x1: number,
    y1: number,
    scale: number,
    out: TileElement[],
  ): void {
    const category = this.colorMode === 'category';
    for (const a of this.aggregates) {
      if (a.bbox.maxx <= ox || a.bbox.minx >= x1 || a.bbox.maxy <= oy || a.bbox.miny >= y1) continue;
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x: a.center[0],
        y: a.center[1],
        w: 2 * a.radius,
        h: 2 * a.radius,
        fill: category ? a.tint : a.fillRGBA,
        layer: 1,
        depth: 0,
      });
      if (2 * a.radius * scale >= LABEL_MIN_CELL_PX && a.label) {
        const text = fitLabel(a.label, labelCapacity());
        if (text) {
          const fill = category ? a.tint : a.fillRGBA;
          out.push({
            type: 'text',
            x: a.center[0],
            y: a.center[1],
            size: labelWorldSize(a.radius),
            text,
            color: labelColorFor(fill),
            font: LABEL_FONT,
            tracking: LABEL_TRACKING,
            align: 'center',
            elevation: 0,
            layer: 3,
            depth: 0,
          });
        }
      }
    }
  }

  /** The aggregate under a world point: the one owning the cell there, or the
   *  glyph covering it when the point fell in a gap between cells. */
  private aggregateAt(wx: number, wy: number): Aggregate | null {
    const w = this.workloadAt(wx, wy);
    if (w && w.groupPath && w.groupPath.length >= 2) {
      const a = this.aggByKey.get(w.groupPath.slice(0, this.aggPrefixLen).join('\u0001'));
      if (a) return a;
    }
    let best: Aggregate | null = null;
    let bestD = Infinity;
    for (const a of this.aggregates) {
      const dx = wx - a.center[0];
      const dy = wy - a.center[1];
      const d = dx * dx + dy * dy;
      if (d < a.radius * a.radius && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  protected override hitTest(wx: number, wy: number, _z: number): TooltipData | null {
    if (this.aggLevelForZoom(this.scene.camera.zoom) > 0) {
      this.setFocus(null);
      const a = this.aggregateAt(wx, wy);
      if (!a) return null;
      const sev = a.worstCrit;
      const status = !a.monitored
        ? 'no health reported'
        : sev > 0.75
          ? 'critical'
          : sev > 0.4
            ? 'warning'
            : 'healthy';
      return {
        title: a.label,
        body: [
          `worst status: ${status}${a.monitored ? ` (${(sev * 100).toFixed(0)}%)` : ''}`,
          `${a.count} resources`,
          'click to zoom in',
        ],
      };
    }
    const w = this.workloadAt(wx, wy);
    // Hovering also picks the cell whose links are drawn in full.
    this.setFocus(w);
    if (!w) return null;
    const sev = w.crit;
    const status = !w.monitored
      ? 'no health reported'
      : sev > 0.75
        ? 'critical'
        : sev > 0.4
          ? 'warning'
          : 'healthy';
    const body: string[] = [
      `status: ${status}${w.monitored ? ` (${(sev * 100).toFixed(0)}%)` : ''}`,
    ];
    if (w.tooltip) body.push(...w.tooltip);
    if (w.resources.length > 0) {
      const worst = Math.max(...w.resources.map((r) => r.current));
      body.push(`worst metric: ${(worst * 100).toFixed(0)}%`);
    }
    if (w.pulse > 0.01) body.push('\u26a0 anomaly active');
    return { title: w.name, body };
  }

  protected override onHoverEnd(): void {
    this.setFocus(null);
  }

  protected override pick(wx: number, wy: number, _z: number): void {
    if (this.aggLevelForZoom(this.scene.camera.zoom) > 0) {
      const a = this.aggregateAt(wx, wy);
      if (!a) return;
      const prect = this.canvas.getBoundingClientRect();
      const targetScale =
        (0.7 * Math.min(Math.max(1, prect.width), Math.max(1, prect.height))) / (2 * a.radius);
      // Zoom past the first cell layer so the drill-in actually reveals cells.
      const zoom = Math.max(
        this.layerBaseZ,
        Math.min(this.maxTileZ, Math.log2(targetScale / TILE_SIZE)),
      );
      this.flyTo({ x: a.center[0], y: a.center[1], zoom });
      return;
    }
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
    const base = this.bodyColor(w);
    const lit = w.pulse > 0.001 ? this.applyPulse(base, w.pulse) : base;
    const f = w.fillRGBA;
    f[0] = lit[0];
    f[1] = lit[1];
    f[2] = lit[2];
  }

  /** Fill array for a workload's layer-0 body: the workload's persistent
   *  fillRGBA, shared with onStep so live updates recolour in place and never
   *  rebuild tiles. Category mode writes the static tint into the same array
   *  (nothing animates it there). */
  private fillFor(w: LiveWorkload, lit: RGBA, alpha: number): RGBA {
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

  /** A cell's health colour — neutral for resources nothing is reported for. */
  private bodyColor(w: LiveWorkload): RGBA {
    return w.monitored ? this.critColor(w.crit) : UNMONITORED;
  }

  private applyPulse(base: RGBA, pulse: number): RGBA {
    const osc = 0.5 + 0.5 * Math.sin(this.clock * 8);
    return interpolateRgb(base, HOT, clamp01(pulse) * osc * 0.75);
  }

  private drawWorkload(
    w: LiveWorkload,
    cellPx: number,
    out: TileElement[],
    ownsWires: boolean,
  ): void {
    const category = this.colorMode === 'category';
    const base = category ? w.tint : this.bodyColor(w);
    const lit = !category && w.pulse > 0.001 ? this.applyPulse(base, w.pulse) : base;
    // While a cell is hovered, only that cell, whatever it is wired to, and the
    // wires between them stay lit; everything else is drawn faded out.
    const focusing = this.relations && this.focusSet !== null && cellPx >= WIRE_MIN_CELL_PX;
    if (focusing && !(this.focusSet as Set<LiveWorkload>).has(w)) {
      // Drawn at the full cell radius, so it swallows its own cluster bed's rim
      // and one hexagon replaces the cell's whole close-up rendering.
      for (const el of this.dimElements(w, lit)) out.push(el);
      return;
    }

    // Close up, show what this resource belongs with: the bed it shares with the
    // rest of its cluster, drawn under the cell.
    if (this.relations && cellPx >= BED_MIN_CELL_PX && w.bedColor) {
      for (const el of this.bedElements(w)) out.push(el);
    }

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
    } else if (focusing && w === this.focus) {
      // On an accent ring, and above it — the ring has to outrank the faded
      // neighbours it overlaps, which the shared body element cannot.
      for (const el of this.anchorElements(w)) out.push(el);
    } else {
      out.push(this.bodyElement(w, lit));
    }

    // Closer still, the wiring itself: hairlines as soon as the cells separate,
    // full-bodied wires further in. Each link is drawn once — by its lower-indexed
    // end, or as two halves when it runs far — so its opacity lands exactly as
    // the kind's style asks. Under focus only the hovered cell's wires remain.
    if (this.relations && w.links && ownsWires && cellPx >= WIRE_MIN_CELL_PX) {
      for (const el of this.wiresFor(w, cellPx, focusing)) out.push(el);
    }

    if (cellPx >= LABEL_MIN_CELL_PX) this.pushLabel(w, lit, elevation, out);
  }

  /** The resource-type code inside the cell, once the cell is big enough. */
  private pushLabel(w: LiveWorkload, lit: RGBA, elevation: number, out: TileElement[]): void {
    const text = fitLabel(w.label ?? w.name, labelCapacity());
    if (!text) return;
    const fill = this.fillFor(w, lit, 1);
    out.push({
      type: 'text',
      x: w.worldCenter[0],
      y: w.worldCenter[1],
      size: labelWorldSize(this.worldHexRadius),
      text,
      color: labelColorFor(fill),
      font: LABEL_FONT,
      tracking: LABEL_TRACKING,
      align: 'center',
      elevation,
      layer: 3,
      depth: 0,
    });
  }

  /**
   * The workload's layer-0 body, built once and then reused by every tile and
   * zoom level that shows it. A single-cell workload is exactly one pointy-top
   * hexagon, so it emits the instanced shape rather than a CPU-tessellated
   * polygon ring; larger clusters keep the merged outline (which also lets the
   * renderer's triangulation cache survive across tiles).
   */
  private bodyElement(w: LiveWorkload, lit: RGBA): ShapeElement | VectorElement {
    let el = w.body;
    if (!el) {
      if (w.cells.length === 1) {
        const d = 2 * this.worldHexRadius * (1 - GAP_FRAC);
        el = {
          type: 'shape',
          shape: 'hexagon',
          x: w.worldCenter[0],
          y: w.worldCenter[1],
          w: d,
          h: d,
          fill: w.fillRGBA,
          layer: 1,
          depth: 0,
        };
      } else {
        el = { type: 'vector', rings: w.outline, fill: w.fillRGBA, layer: 1, depth: 0 };
      }
      w.body = el;
    }
    this.fillFor(w, lit, w.cells.length === 1 ? 1 : 0.95);
    return el;
  }

  /**
   * The bed under a workload: one hexagon per cell at the full cell radius,
   * filled with the cluster's colour. Full radius means the beds of cells in the
   * same cluster meet with no seam, so a resource group reads as one slab that
   * its cells sit on, while the moat walling the cluster off stays background.
   * Built once and shared by every tile, like `body`.
   */
  private bedElements(w: LiveWorkload): ShapeElement[] {
    let bed = w.bed;
    if (!bed) {
      const d = 2 * this.worldHexRadius;
      const fill = w.bedColor ?? this.neutralTint;
      bed = w.worldCells.map(([x, y]) => ({
        type: 'shape' as const,
        shape: 'hexagon' as const,
        x,
        y,
        w: d,
        h: d,
        fill,
        layer: 0,
        depth: 0,
      }));
      w.bed = bed;
    }
    return bed;
  }

  /** A cell the hover has nothing to do with, drawn in its own colour faded into
   *  the background. One hexagon at the full cell radius replaces bed, body and
   *  everything else, so a faded map costs fewer instances than a lit one. */
  private dimElements(w: LiveWorkload, lit: RGBA): ShapeElement[] {
    const f = (w.dimRGBA ??= [0, 0, 0, 1]);
    for (let i = 0; i < 3; i++) f[i] = this.bg[i] + (lit[i] - this.bg[i]) * DIM_MIX;
    let dim = w.dim;
    if (!dim) {
      const d = 2 * this.worldHexRadius;
      dim = w.worldCells.map(([x, y]) => ({
        type: 'shape' as const,
        shape: 'hexagon' as const,
        x,
        y,
        w: d,
        h: d,
        fill: f,
        layer: 1,
        depth: 0,
      }));
      w.dim = dim;
    }
    return dim;
  }

  /** The hovered cell itself: an accent ring, and its body above it. Built fresh
   *  — one cell is ever hovered, and the ring has to sit above the faded cells
   *  around it, which the shared body element's layer cannot. */
  private anchorElements(w: LiveWorkload): ShapeElement[] {
    const out: ShapeElement[] = [];
    const d = 2 * this.worldHexRadius * (1 - GAP_FRAC);
    const ring = 2 * this.worldHexRadius * FOCUS_RING;
    for (const [x, y] of w.worldCells) {
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x,
        y,
        w: ring,
        h: ring,
        fill: FOCUS_RING_COLOR,
        layer: 2,
        depth: 0,
      });
      out.push({
        type: 'shape',
        shape: 'hexagon',
        x,
        y,
        w: d,
        h: d,
        fill: this.fillFor(w, this.colorMode === 'category' ? w.tint : this.bodyColor(w), 1),
        layer: 3,
        depth: 0,
      });
    }
    return out;
  }

  /**
   * A workload's standing wires, cached per tier. Both ends are trimmed back so
   * the wire crosses the seam between the two cells without covering either
   * centre (and its glyph). A short link is one line, drawn by its lower-indexed
   * end; a long one is drawn as two halves, one from each end. Either way every
   * piece is drawn exactly once, which is what lets a kind's opacity mean what
   * it says.
   */
  private wireElements(w: LiveWorkload): VectorElement[] {
    return (w.wires ??= this.buildWires(w, { faint: false }));
  }

  /** The same wires as hairlines: a constant screen width, so they stay visible
   *  when a cell is only a few pixels across instead of thinning to nothing. */
  private faintWireElements(w: LiveWorkload): VectorElement[] {
    return (w.wiresFaint ??= this.buildWires(w, { faint: true }));
  }

  /** Every link of the hovered cell, whole rather than halved, opaque and
   *  thicker. Built fresh: only one cell is ever hovered. */
  private focusWires(w: LiveWorkload): VectorElement[] {
    return this.buildWires(w, { faint: false, gain: FOCUS_WIRE_GAIN, all: true });
  }

  /** What this cell contributes to the wiring at this zoom: while a cell is
   *  hovered, only that one draws — its whole link set. */
  private wiresFor(w: LiveWorkload, cellPx: number, focusing: boolean): VectorElement[] {
    if (focusing) return w === this.focus ? this.focusWires(w) : NO_WIRES;
    return cellPx >= WIRE_FULL_CELL_PX ? this.wireElements(w) : this.faintWireElements(w);
  }

  private buildWires(
    w: LiveWorkload,
    opts: { faint: boolean; gain?: number; all?: boolean },
  ): VectorElement[] {
    const R = this.worldHexRadius;
    const trim = WIRE_TRIM * R;
    const gain = opts.gain ?? 1;
    const base = opts.faint ? WIRE_FAINT_PX : WIRE_WIDTH * R;
    const split = WIRE_SPLIT_SPAN * SQRT3 * R;
    const [x0, y0] = w.worldCenter;
    const out: VectorElement[] = [];
    for (const l of w.links ?? []) {
      const o = l.to;
      if (!this.linkVisible(l.kind)) continue;
      const dx = o.worldCenter[0] - x0;
      const dy = o.worldCenter[1] - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      // A link that runs further than `split` is drawn as two halves, one from
      // each end, so it shows from either side even when the far end is well
      // outside the loaded tiles. Shorter ones are a single line, left to the
      // lower-indexed end.
      const halve = !opts.all && len > split;
      if (!opts.all && !halve && o.index < w.index) continue;
      const t = Math.min(trim, len * 0.4);
      const ux = (dx / len) * t;
      const uy = (dy / len) * t;
      const ex = halve ? x0 + dx * 0.5 : o.worldCenter[0] - ux;
      const ey = halve ? y0 + dy * 0.5 : o.worldCenter[1] - uy;
      const st = this.linkStyle(l.kind, opts.faint, opts.all === true);
      out.push({
        type: 'vector',
        rings: [[x0 + ux, y0 + uy, ex, ey]],
        stroke: st.color,
        strokeWidth: base * st.width * gain,
        strokeScreen: opts.faint,
        layer: 2,
        depth: 0,
      });
    }
    return out;
  }

  /** The colour and width multiplier for a link kind in one tier: as declared
   *  when drawn in full, dimmed as a hairline, fully opaque under the pointer. */
  private linkStyle(
    kind: string | undefined,
    faint: boolean,
    focused: boolean,
  ): { color: RGBA; width: number } {
    const key = `${kind ?? ''}|${faint ? 'f' : focused ? 'o' : 'n'}`;
    let st = this.linkStyleCache.get(key);
    if (!st) {
      const base = (kind ? this.linkStyles[kind] : undefined) ?? { color: WIRE_COLOR };
      const a = base.color[3];
      const alpha = faint ? a * WIRE_FAINT_ALPHA : focused ? 1 : a;
      st = {
        color: [base.color[0], base.color[1], base.color[2], alpha],
        width: base.width ?? 1,
      };
      this.linkStyleCache.set(key, st);
    }
    return st;
  }

  /**
   * Track the cell under the pointer, together with everything it is wired to:
   * that set stays lit while the rest of the map fades out. Only while focus
   * mode is on — changing it rebuilds the visible tiles, so left on by default
   * the map would redraw for every cell the pointer merely crosses.
   */
  private setFocus(w: LiveWorkload | null): void {
    const next = this.focusMode ? w : null;
    if (this.focus === next) return;
    this.focus = next;
    this.rebuildFocusSet();
    if (this.focusVisible()) this.invalidate();
  }

  private rebuildFocusSet(): void {
    const w = this.focus;
    if (!w) {
      this.focusSet = null;
      return;
    }
    const set = new Set<LiveWorkload>([w]);
    for (const l of w.links ?? []) if (this.linkVisible(l.kind)) set.add(l.to);
    this.focusSet = set;
  }

  private linkVisible(kind: string | undefined): boolean {
    return kind === undefined || !this.hiddenKinds.has(kind);
  }

  private focusVisible(): boolean {
    if (!this.relations) return false;
    const cellPx = 2 * this.worldHexRadius * TILE_SIZE * Math.pow(2, this.currentTileZ);
    return cellPx >= WIRE_MIN_CELL_PX;
  }

  /**
   * Resolve every `deps` entry into a direct reference on both endpoints, so a
   * cell knows its links whichever end of one it is, and carries the kind the
   * wire is drawn in. Names with no placed cell (and self-links) are dropped.
   */
  private buildRelations(placed: { input: WorkloadInput; p: PlacedWorkload }[]): void {
    for (const { input } of placed) {
      const deps = input.deps;
      if (!deps || deps.length === 0) continue;
      const a = this.byName.get(input.name);
      if (!a) continue;
      for (const dep of deps) {
        const b = this.byName.get(linkId(dep));
        if (!b || b === a || a.links?.some((l) => l.to === b)) continue;
        const kind = typeof dep === 'string' ? undefined : dep.kind;
        (a.links ??= []).push({ to: b, kind });
        (b.links ??= []).push({ to: a, kind });
      }
    }
  }

  /**
   * Bed colour for a containment path: a stable hue per cluster, mixed most of
   * the way back toward the background so neighbouring clusters stay
   * distinguishable without the bed competing with the health colour drawn on
   * top of it.
   */
  private bedColorFor(path: string[] | undefined): RGBA | undefined {
    if (!path || path.length === 0) return undefined;
    const key = path.join('\u0001');
    let c = this.bedColors.get(key);
    if (!c) {
      c = this.bedTarget(key);
      this.bedColors.set(key, c);
    }
    return c;
  }

  private bedTarget(key: string): RGBA {
    const hue = this.colorMode === 'category' ? BED_NEUTRAL : BED_HUE(hashString(key));
    const c = interpolateRgb(this.bg, hue, BED_MIX);
    c[3] = 1; // opaque: a bed is drawn again wherever a cell straddles two tiles
    return c;
  }

  /** Repaint every bed in place after a colour-mode switch — the cached bed
   *  elements hold on to these very arrays. */
  private refreshBedColors(): void {
    for (const [key, c] of this.bedColors) {
      const t = this.bedTarget(key);
      c[0] = t[0];
      c[1] = t[1];
      c[2] = t[2];
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

    const fillR = cellR * SUB_FILL;
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
        // Nest the gap across layers: also omit this fine cell if its centre
        // falls in a COARSER sub-layer's inter-cell gap, so the honeycomb keeps
        // visible gaps at every scale (self-similar) as you zoom deeper — the
        // same gap treatment layer 0 gets, applied to each intermediate layer.
        if (this.inNestedGap(wx, wy, layer)) continue;
        out.push({
          type: 'shape',
          shape: 'hexagon',
          x: wx,
          y: wy,
          w: 2 * fillR,
          h: 2 * fillR,
          fill: this.subCellColor(host, q, r, layer),
          layer: 1,
          depth: 0,
        });
      }
    }
  }

  /**
   * True if (wx, wy) falls in the inter-cell gap of any sub-layer COARSER than
   * `layer` (1 .. layer-1). Each coarser layer draws its cells at SUB_FILL of
   * their radius, so the gap is everything outside the containing coarser
   * cell's SUB_FILL core. Testing every coarser layer makes the honeycomb gaps
   * nest self-similarly, so they stay visible at every zoom depth.
   */
  private inNestedGap(wx: number, wy: number, layer: number): boolean {
    for (let k = 1; k < layer; k++) {
      const kR = this.worldHexRadius / Math.pow(LAYER_SUBDIV, k);
      const [kfq, kfr] = pixelToAxial(wx - 0.5, wy - 0.5, kR);
      const [kq, kr] = hexRound(kfq, kfr);
      const [kpx, kpy] = axialToPixel(kq, kr, kR);
      if (!inHexCore(wx - 0.5 - kpx, wy - 0.5 - kpy, SUB_FILL * kR)) return true;
    }
    return false;
  }

  /**
   * Colour of a layer-L sub-cell: the host workload's severity, textured by a
   * hash-picked resource and a small deterministic jitter so the fill reads as
   * many distinct cells rather than a flat wash.
   */
  private subCellColor(host: LiveWorkload, q: number, r: number, layer: number): RGBA {
    const h = hashCell(q, r, layer);
    if (this.colorMode === 'category') {
      const j = ((h >>> 8) / 0xffffff - 0.5) * 0.1;
      const t = host.tint;
      return [clamp01(t[0] + j), clamp01(t[1] + j), clamp01(t[2] + j), 1];
    }
    let sev = host.crit;
    if (host.resources.length > 0) {
      sev = sev * 0.45 + host.resources[h % host.resources.length].current * 0.55;
    }
    const jitter = ((h >>> 8) / 0xffffff - 0.5) * 0.22;
    return this.critColor(clamp01(sev + jitter));
  }
}
