// Deterministic workload placement on the hex grid.
//
// Each workload's home cell is a pure function of its name (a hash selects a
// spiral index), so a given name always lands in the same neighborhood. If that
// cell is taken, we probe forward along the spiral ??deterministic as long as
// workloads are placed in a stable order. Multi-cell workloads then claim a
// contiguous cluster of free cells by breadth-first growth from the anchor.

import {
  hexNeighbors,
  hexSpiral,
  hexDistance,
  spiralRadiusFor,
  axialToPixel,
  pixelToAxial,
  hexRound,
  axialKey,
  type Axial,
} from './hex';

export interface PlacedWorkload {
  name: string;
  size: number;
  anchor: Axial;
  cells: Axial[];
}

/** One workload to place, tagged with the group it should cluster with. */
export interface GroupedItem {
  name: string;
  size: number;
  /** Locality key ??items sharing a group land in one contiguous blob. */
  group: string;
}

/** FNV-1a hash of a string ??uint32. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class HexPlacer {
  private readonly occupied = new Set<string>();
  private readonly spiral: Axial[];

  constructor(maxRadius = 40) {
    this.spiral = hexSpiral(maxRadius);
  }

  /** Place `name` occupying `size` cells; returns the claimed cluster. */
  place(name: string, size = 1): PlacedWorkload {
    const n = this.spiral.length;
    const start = hashString(name) % n;

    // Probe forward along the spiral for a free anchor.
    let anchor: Axial = this.spiral[start];
    for (let k = 0; k < n; k++) {
      const c = this.spiral[(start + k) % n];
      if (!this.occupied.has(axialKey(c[0], c[1]))) {
        anchor = c;
        break;
      }
    }

    const cells = this.claim(anchor, Math.max(1, size));
    for (const c of cells) this.occupied.add(axialKey(c[0], c[1]));
    return { name, size: cells.length, anchor, cells };
  }

  /**
   * Place many workloads with locality: every workload sharing a `group` key is
   * packed into one contiguous blob of cells, and groups are laid down in
   * first-appearance order, each growing from the first free cell along the
   * spiral ??so consecutive groups end up adjacent and the whole estate fills a
   * compact disc from the centre out. Within a group, members receive
   * consecutive cells in input order, so a secondary sort (e.g. resource group,
   * then type) produces sub-neighbourhoods inside each blob.
   *
   * Returns placements aligned to the input order. Deterministic for a given
   * input order. If the grid is exhausted, trailing items get an empty cell list.
   */
  placeGrouped(items: GroupedItem[]): PlacedWorkload[] {
    // Bucket members by group, preserving first-appearance (group order) and
    // input order (member order within a group).
    const order: string[] = [];
    const members = new Map<string, GroupedItem[]>();
    for (const it of items) {
      let bucket = members.get(it.group);
      if (!bucket) {
        bucket = [];
        members.set(it.group, bucket);
        order.push(it.group);
      }
      bucket.push(it);
    }

    const result = new Map<string, PlacedWorkload>();
    const n = this.spiral.length;
    for (const g of order) {
      const bucket = members.get(g) as GroupedItem[];
      const total = bucket.reduce((s, it) => s + Math.max(1, it.size), 0);

      // First free cell along the spiral anchors this group's blob.
      let anchor: Axial | null = null;
      for (let k = 0; k < n; k++) {
        const c = this.spiral[k];
        if (!this.occupied.has(axialKey(c[0], c[1]))) {
          anchor = c;
          break;
        }
      }
      if (!anchor) break; // grid exhausted

      // Grow one contiguous blob for the whole group and reserve every cell.
      const blob = this.claim(anchor, total);
      for (const c of blob) this.occupied.add(axialKey(c[0], c[1]));

      // Hand out consecutive cells to each member (keeping its own size).
      let cursor = 0;
      for (const it of bucket) {
        const want = Math.max(1, it.size);
        const cells = blob.slice(cursor, cursor + want);
        cursor += cells.length;
        result.set(it.name, {
          name: it.name,
          size: cells.length,
          anchor: cells[0] ?? anchor,
          cells,
        });
      }
    }

    return items.map(
      (it) => result.get(it.name) ?? { name: it.name, size: 0, anchor: [0, 0], cells: [] },
    );
  }

  /**
   * Grow a contiguous cluster of up to `size` free cells from `anchor`.
   * Greedy-compact: each step adds the free frontier cell that shares the most
   * edges with the cells already chosen (fills concavities first), breaking ties
   * toward the cell nearest the anchor so the blob grows radially ??round and
   * unbiased ??rather than drifting in one direction. Deterministic: remaining
   * ties break on a stable axial-key ordering.
   */
  private claim(anchor: Axial, size: number): Axial[] {
    const chosen: Axial[] = [];
    const chosenKeys = new Set<string>();
    const anchorKey = axialKey(anchor[0], anchor[1]);
    if (this.occupied.has(anchorKey)) return chosen;
    chosen.push(anchor);
    chosenKeys.add(anchorKey);

    while (chosen.length < size) {
      let best: Axial | null = null;
      let bestAdj = -1;
      let bestDist = Infinity;
      let bestKey = '';
      const considered = new Set<string>();
      for (const cell of chosen) {
        for (const nb of hexNeighbors(cell[0], cell[1])) {
          const k = axialKey(nb[0], nb[1]);
          if (chosenKeys.has(k) || this.occupied.has(k) || considered.has(k)) continue;
          considered.add(k);
          // Prefer the cell touching the most chosen cells; then the one closest
          // to the anchor (keeps the blob compact/round); then a stable key.
          const adj = this.countChosen(nb, chosenKeys);
          const dist = hexDistance(nb[0], nb[1], anchor[0], anchor[1]);
          if (
            adj > bestAdj ||
            (adj === bestAdj && dist < bestDist) ||
            (adj === bestAdj && dist === bestDist && k < bestKey)
          ) {
            best = nb;
            bestAdj = adj;
            bestDist = dist;
            bestKey = k;
          }
        }
      }
      if (!best) break; // no free frontier cell left
      chosen.push(best);
      chosenKeys.add(bestKey);
    }
    return chosen;
  }

  /** Count how many of `chosenKeys` are neighbours of `cell`. */
  private countChosen(cell: Axial, chosenKeys: Set<string>): number {
    let adj = 0;
    for (const nb of hexNeighbors(cell[0], cell[1])) {
      if (chosenKeys.has(axialKey(nb[0], nb[1]))) adj++;
    }
    return adj;
  }
}

// ?�?�?Hierarchical placement with graduated gaps ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
//
// Lay workloads out by a group *path* (coarse ??fine, e.g. [mgmtGroup,
// subscription, resourceGroup]) so that items grow as tight blobs at the leaf
// and each level of the hierarchy is separated by empty "moat" cells. The gap
// widens the higher up the tree two neighbours diverge ??items with low
// locality are pushed visibly apart, while tightly-related items stay fused.

/** One workload to place hierarchically, tagged with its group path. */
export interface HierItem {
  name: string;
  size: number;
  /** Group keys from coarsest (index 0) to finest. */
  path: string[];
  /**
   * Optional "shared-ness" in [0, 1] ??how common the resource is to the rest of
   * its cluster (e.g. spoke network or hub connectivity ??1, a single VM ??0).
   * Affinity placement pulls higher values toward the centre of their cluster so
   * shared infrastructure sits in the middle (best effort). Default 0.
   */
  central?: number;
}

/** A placed sub-tree: its members (with local cells) and the union of all cells. */
interface Cluster {
  members: { name: string; cells: Axial[] }[];
  cells: Axial[];
}

/** Default target aspect ratio (width:height) for the overall footprint ??a 16:9 monitor. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * Squared distance from the origin in pixel space with the vertical axis scaled
 * by `bias`, so "nearest" prefers spreading horizontally. Growth/packing that
 * minimise it fill a wide footprint; `bias` is tuned by {@link placeHierarchical}
 * so the achieved width:height converges on the requested aspect.
 */
function aspectDist2(q: number, r: number, bias: number): number {
  const [px, py] = axialToPixel(q, r, 1);
  const ay = bias * py;
  return px * px + ay * ay;
}

/** Width:height of the pixel-space bounding box of `cells`. */
function pixelAspect(cells: Axial[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [q, r] of cells) {
    const [px, py] = axialToPixel(q, r, 1);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const h = maxY - minY;
  return h > 1e-9 ? (maxX - minX) / h : 1;
}

/** Count how many of `keys` are neighbours of cell (q, r). */
function countAdjacent(q: number, r: number, keys: Set<string>): number {
  let adj = 0;
  for (const nb of hexNeighbors(q, r)) {
    if (keys.has(axialKey(nb[0], nb[1]))) adj++;
  }
  return adj;
}

/**
 * Grow one compact, contiguous blob of `size` cells from the origin (0,0).
 * Same greedy rule as {@link HexPlacer} claim (most shared edges first), but
 * ties break toward the smallest aspect-weighted distance so the blob leans
 * into an `aspect`:1 footprint. Self-contained so leaf blobs build in isolation.
 */
function growBlobCompact(size: number, aspect: number): Axial[] {
  if (size <= 0) return [];
  const chosen: Axial[] = [[0, 0]];
  const keys = new Set<string>(['0,0']);
  while (chosen.length < size) {
    let best: Axial | null = null;
    let bestAdj = -1;
    let bestDist = Infinity;
    let bestKey = '';
    const considered = new Set<string>();
    for (const cell of chosen) {
      for (const nb of hexNeighbors(cell[0], cell[1])) {
        const k = axialKey(nb[0], nb[1]);
        if (keys.has(k) || considered.has(k)) continue;
        considered.add(k);
        const adj = countAdjacent(nb[0], nb[1], keys);
        const dist = aspectDist2(nb[0], nb[1], aspect);
        if (
          adj > bestAdj ||
          (adj === bestAdj && dist < bestDist) ||
          (adj === bestAdj && dist === bestDist && k < bestKey)
        ) {
          best = nb;
          bestAdj = adj;
          bestDist = dist;
          bestKey = k;
        }
      }
    }
    if (!best) break;
    chosen.push(best);
    keys.add(bestKey);
  }
  return chosen;
}

/** Translate a cluster so the mean of its cells sits at (0,0) ??keeps packs compact. */
function recenter(cluster: Cluster): Cluster {
  const n = cluster.cells.length;
  if (n === 0) return cluster;
  let sq = 0;
  let sr = 0;
  for (const c of cluster.cells) {
    sq += c[0];
    sr += c[1];
  }
  const oq = Math.round(sq / n);
  const or = Math.round(sr / n);
  if (oq === 0 && or === 0) return cluster;
  const shift = ([q, r]: Axial): Axial => [q - oq, r - or];
  return {
    members: cluster.members.map((m) => ({ name: m.name, cells: m.cells.map(shift) })),
    cells: cluster.cells.map(shift),
  };
}

const CELL_SPACING = Math.sqrt(3); // pixel distance between adjacent hex centres (size 1)

/** Bounding radius (pixel units) of a recentred cluster's cells. */
function clusterRadiusPx(cells: Axial[]): number {
  let max = 0;
  for (const [q, r] of cells) {
    const [px, py] = axialToPixel(q, r, 1);
    const d = px * px + py * py;
    if (d > max) max = d;
  }
  return Math.sqrt(max) + 1; // + one cell's half-extent
}

/**
 * Pack child clusters into one wide (`aspect`:1) arrangement, leaving ~`pad`
 * empty cells between neighbours. Each cluster is treated as a bounding circle
 * and dropped at the nearest (aspect-weighted) free centre; collisions are
 * tested against a coarse grid of already-placed circles, so this stays fast
 * (O(1) per test) even when packing thousands of clusters ??the key to scaling
 * to tens of thousands of cells.
 */
function packClusters(children: Cluster[], pad: number, aspect: number): Cluster {
  const members: { name: string; cells: Axial[] }[] = [];
  const cells: Axial[] = [];
  const gapPx = Math.max(0, pad) * CELL_SPACING;

  const radii = children.map((c) => (c.cells.length ? clusterRadiusPx(c.cells) : 0));
  let maxR = 1;
  let minR = Infinity;
  let sumA = 0;
  for (const rr of radii) {
    if (rr <= 0) continue;
    if (rr > maxR) maxR = rr;
    if (rr < minR) minR = rr;
    const e = rr + gapPx;
    sumA += e * e;
  }
  if (!isFinite(minR)) minR = 1;
  const bin = 2 * maxR + gapPx + 1; // any two overlapping circles fall within one bin

  // Candidate centres on a hex lattice generous enough to hold every circle,
  // sub-sampled to ~the smallest circle so the list stays small (fast) yet has
  // enough resolution to nestle clusters together.
  const needRpx = Math.sqrt((sumA / 0.4) * Math.max(1, aspect));
  const step = Math.max(1, Math.round(minR / (1.5 * CELL_SPACING)));
  const spiralR = Math.max(4, Math.ceil(needRpx / (CELL_SPACING * step)) + 2);
  const cands = hexSpiral(spiralR)
    .map((c) => {
      const q = c[0] * step;
      const r = c[1] * step;
      const [px, py] = axialToPixel(q, r, 1);
      return { q, r, px, py, w: aspectDist2(q, r, aspect) };
    })
    .sort((a, b) => a.w - b.w);

  // Coarse grid of placed circles: bin key "bx,by" ??circles, for O(1) collision.
  const grid = new Map<string, { px: number; py: number; r: number }[]>();
  const clear = (px: number, py: number, cr: number): boolean => {
    const bx = Math.floor(px / bin);
    const by = Math.floor(py / bin);
    for (let gy = by - 1; gy <= by + 1; gy++) {
      for (let gx = bx - 1; gx <= bx + 1; gx++) {
        const list = grid.get(gx + ',' + gy);
        if (list && circleHits(px, py, cr, gapPx, list)) return false;
      }
    }
    return true;
  };

  children.forEach((child, ci) => {
    if (child.cells.length === 0) return;
    const cr = radii[ci];
    let hit = cands[cands.length - 1]; // fallback (never expected: area is generous)
    for (const cand of cands) {
      if (clear(cand.px, cand.py, cr)) {
        hit = cand;
        break;
      }
    }
    const key = Math.floor(hit.px / bin) + ',' + Math.floor(hit.py / bin);
    const circle = { px: hit.px, py: hit.py, r: cr };
    const list = grid.get(key);
    if (list) list.push(circle);
    else grid.set(key, [circle]);
    for (const m of child.members) {
      members.push({ name: m.name, cells: m.cells.map(([q, r]) => [q + hit.q, r + hit.r] as Axial) });
    }
    for (const c of child.cells) cells.push([c[0] + hit.q, c[1] + hit.r] as Axial);
  });
  return { members, cells };
}

/** True if a circle (px,py,cr) is closer than the gap to any circle in `list`. */
function circleHits(
  px: number,
  py: number,
  cr: number,
  gapPx: number,
  list: { px: number; py: number; r: number }[],
): boolean {
  for (const p of list) {
    const need = cr + p.r + gapPx;
    const dx = px - p.px;
    const dy = py - p.py;
    if (dx * dx + dy * dy < need * need) return true;
  }
  return false;
}

/**
 * Recursively lay out one hierarchy level; `pads[level]` gaps its children.
 * The aspect stretch is applied only at the first level that actually splits
 * (the coarsest partition); deeper levels and leaf blobs stay round, so the
 * overall footprint reaches `aspect`:1 without compounding into a thin sliver.
 */
function buildLevel(items: HierItem[], level: number, pads: number[], aspect: number): Cluster {
  if (!items.some((it) => it.path.length > level)) {
    // Leaf: one tight, round blob shared by all members here.
    const total = items.reduce((s, it) => s + Math.max(1, it.size), 0);
    const blob = growBlobCompact(total, 1);
    const members: { name: string; cells: Axial[] }[] = [];
    let cursor = 0;
    for (const it of items) {
      const want = Math.max(1, it.size);
      const cs = blob.slice(cursor, cursor + want);
      cursor += cs.length;
      members.push({ name: it.name, cells: cs });
    }
    return recenter({ members, cells: blob });
  }

  // Partition by this level's key (stable, first-appearance order).
  const order: string[] = [];
  const groups = new Map<string, HierItem[]>();
  for (const it of items) {
    const key = it.path[level] ?? '';
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(it);
  }
  if (order.length === 1) return buildLevel(items, level + 1, pads, aspect); // carry until first split
  // Coarsest split fills an aspect:1 footprint; sub-levels stay round.
  const children = order.map((k) => buildLevel(groups.get(k) as HierItem[], level + 1, pads, 1));
  return recenter(packClusters(children, pads[level] ?? 0, aspect));
}

/**
 * Descend to the coarsest level that actually splits and build its child
 * clusters once (round; aspect is applied later when packing them). Returns
 * null when the items never split (a single leaf blob). Doing this once keeps
 * the expensive sub-tree layout out of the aspect-convergence loop.
 */
function firstSplit(items: HierItem[], pads: number[]): { children: Cluster[]; pad: number } | null {
  for (let level = 0; ; level++) {
    if (!items.some((it) => it.path.length > level)) return null;
    const order: string[] = [];
    const groups = new Map<string, HierItem[]>();
    for (const it of items) {
      const key = it.path[level] ?? '';
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
        order.push(key);
      }
      bucket.push(it);
    }
    if (order.length > 1) {
      const children = order.map((k) => buildLevel(groups.get(k) as HierItem[], level + 1, pads, 1));
      return { children, pad: pads[level] ?? 0 };
    }
  }
}

/**
 * Place items by their group path with graduated gaps. `pads[i]` is the number
 * of empty cells left between groups that first diverge at path level `i`
 * (index 0 = coarsest). Use ascending-then-descending values like `[3, 1, 0]`
 * so coarser boundaries read as wider streets. `aspect` (width:height, default
 * 16:9) biases the whole layout toward a wide rectangle instead of a disc.
 * Returns placements aligned to the input order; deterministic for a given input.
 */
export function placeHierarchical(
  items: HierItem[],
  pads: number[],
  aspect: number = DEFAULT_ASPECT,
): PlacedWorkload[] {
  const target = aspect > 0 ? aspect : 1;
  const split = firstSplit(items, pads);
  let root: Cluster;
  if (!split) {
    root = buildLevel(items, 0, pads, 1);
  } else {
    // Sub-clusters are built once; only the coarsest pack is re-run as we nudge
    // the vertical bias so the achieved footprint aspect converges on `target`.
    let bias = target;
    root = recenter(packClusters(split.children, split.pad, bias));
    for (let i = 0; i < 3; i++) {
      const measured = pixelAspect(root.cells);
      if (measured <= 0 || Math.abs(measured - target) <= 0.06 * target) break;
      bias = Math.max(1, Math.min(6, bias * (target / measured)));
      root = recenter(packClusters(split.children, split.pad, bias));
    }
  }
  const byName = new Map<string, Axial[]>();
  for (const m of root.members) byName.set(m.name, m.cells);
  return items.map((it) => {
    const cells = byName.get(it.name) ?? [];
    return { name: it.name, size: cells.length, anchor: cells[0] ?? [0, 0], cells };
  });
}

// ?�?�?Dense "territory map" placement ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
//
// Circle-packing (placeHierarchical) arranges each group as a bounding circle,
// which inherently leaves black interstitial gaps between clusters. `placeDense`
// instead grows the WHOLE estate as one gap-free honeycomb and recursively
// carves it into contiguous group territories (like a country map), so the only
// empty space is outside the outline. The `aspect` preference shapes just that
// outline (wider ??fills a 16:9 screen when fit) ??it never scatters clusters.

/** Lexicographic compare of two group paths (coarsest element first). */
function comparePath(a: string[], b: string[]): number {
  const m = Math.max(a.length, b.length);
  for (let k = 0; k < m; k++) {
    const x = a[k] ?? '';
    const y = b[k] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Grow up to `size` cells outward from `anchor`, staying on cells where
 * `isFree` holds. Each step takes the frontier cell sharing the most edges with
 * the region so far (fills concavities ??the blob stays compact and hugs the
 * cells already carved, so sibling territories tessellate with no holes). Ties
 * break toward the cell nearest the blob's *running centroid* (not the fixed
 * anchor, which goes stale as the blob fills asymmetrically) ??this keeps growth
 * radially balanced so the territory stays round instead of drifting into a long
 * finger ??then a stable key. O(size) via adjacency buckets (a frontier cell
 * lives in the bucket for its chosen-edge count).
 */
export function growBlob(
  anchor: Axial,
  size: number,
  isFree: (q: number, r: number) => boolean,
): Axial[] {
  const chosen: Axial[] = [];
  const chosenKeys = new Set<string>();
  const buckets: Map<string, Axial>[] = [];
  for (let i = 0; i < 7; i++) buckets.push(new Map());
  const adjOf = new Map<string, number>();
  // Running sum of chosen axial coords ??centroid, so ties break toward the
  // blob's current middle and it grows round rather than elongating.
  let sumQ = 0;
  let sumR = 0;
  const refresh = (q: number, r: number): void => {
    const k = axialKey(q, r);
    if (chosenKeys.has(k) || !isFree(q, r)) return;
    let adj = 0;
    for (const nb of hexNeighbors(q, r)) if (chosenKeys.has(axialKey(nb[0], nb[1]))) adj++;
    const prev = adjOf.get(k);
    if (prev === adj) return;
    if (prev !== undefined) buckets[prev].delete(k);
    adjOf.set(k, adj);
    buckets[adj].set(k, [q, r]);
  };
  const place = (q: number, r: number): void => {
    const k = axialKey(q, r);
    chosen.push([q, r]);
    chosenKeys.add(k);
    sumQ += q;
    sumR += r;
    const prev = adjOf.get(k);
    if (prev !== undefined) {
      buckets[prev].delete(k);
      adjOf.delete(k);
    }
    for (const nb of hexNeighbors(q, r)) refresh(nb[0], nb[1]);
  };
  if (!isFree(anchor[0], anchor[1])) return chosen;
  place(anchor[0], anchor[1]);
  while (chosen.length < size) {
    // Centroid of the cells chosen so far (keeps the pick radially centred).
    const cq = sumQ / chosen.length;
    const cr = sumR / chosen.length;
    let pick: Axial | null = null;
    let pd = Infinity;
    let pk = '';
    for (let b = 6; b >= 0; b--) {
      if (buckets[b].size === 0) continue;
      for (const [k, cell] of buckets[b]) {
        // Squared hex-axial distance to the centroid (??pixel distance²).
        const dq = cell[0] - cq;
        const dr = cell[1] - cr;
        const d = dq * dq + dq * dr + dr * dr;
        if (pick === null || d < pd || (d === pd && k < pk)) {
          pick = cell;
          pd = d;
          pk = k;
        }
      }
      break; // only the most-connected non-empty bucket
    }
    if (!pick) break;
    place(pick[0], pick[1]);
  }
  return chosen;
}

/** Reserve a `width`-thick ring of empty "moat" cells around `blob` (breadth-
 *  first from its boundary), marking every not-yet-occupied cell as blocked so
 *  the next territory can't grow into it ??a consistent gap between groups. */
export function reserveMoat(
  blob: Axial[],
  width: number,
  occupied: Set<string>,
  blocked: Set<string>,
): void {
  if (width <= 0) return;
  let ring = blob;
  const seen = new Set<string>(blob.map((c) => axialKey(c[0], c[1])));
  for (let d = 0; d < width; d++) {
    const next: Axial[] = [];
    for (const c of ring) {
      for (const nb of hexNeighbors(c[0], c[1])) {
        const k = axialKey(nb[0], nb[1]);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!occupied.has(k)) {
          blocked.add(k);
          next.push(nb);
        }
      }
    }
    ring = next;
  }
}

/**
 * Organic "territory map" placement. Groups workloads by the first path level
 * where the estate diverges (the selected locality ??e.g. hubs for a hub
 * layout) and grows each group as a compact, organically-shaped blob into open
 * space, seeding from the centre outward so related territories end up adjacent
 * like regions on a map. A uniform empty "moat" separates each group so the
 * selected criterion reads clearly, while cells inside a group stay dense. No
 * rigid grid; every workload's cells are contiguous; deterministic (a given
 * estate always yields identical positions); returns placements in input order.
 */
export function placeDense(items: HierItem[]): PlacedWorkload[] {
  if (items.length === 0) return [];
  const order = items
    .map((_, i) => i)
    .sort((a, b) => comparePath(items[a].path, items[b].path) || a - b);
  const sorted = order.map((i) => items[i]);

  let total = 0;
  let maxLevel = 0;
  for (const it of sorted) {
    total += Math.max(1, it.size);
    if (it.path.length > maxLevel) maxLevel = it.path.length;
  }

  // First path level whose key varies across the estate ??the territory level.
  let splitLevel = 0;
  while (splitLevel < maxLevel) {
    const first = sorted[0].path[splitLevel] ?? '';
    if (sorted.some((it) => (it.path[splitLevel] ?? '') !== first)) break;
    splitLevel++;
  }
  const groups: HierItem[][] = [];
  let curKey: string | null = null;
  for (const it of sorted) {
    const key = it.path[splitLevel] ?? it.name;
    if (key !== curKey) {
      groups.push([]);
      curKey = key;
    }
    groups[groups.length - 1].push(it);
  }

  // Grow each territory as a compact blob into the open plane, anchored at the
  // innermost still-free cell (centre-out), so territories tile organically.
  // A uniform moat (sized from the average territory, so it's consistent within
  // a layout) keeps a constant empty gap between groups.
  const moat = Math.min(4, Math.max(1, Math.round(Math.sqrt(total / groups.length) * 0.15)));
  const spiral = hexSpiral(spiralRadiusFor(Math.ceil(total * 1.8)) + 8);
  const occupied = new Set<string>();
  const blocked = new Set<string>();
  const isFree = (q: number, r: number): boolean => {
    const k = axialKey(q, r);
    return !occupied.has(k) && !blocked.has(k);
  };
  let cursor = 0;
  const assign = new Map<string, Axial[]>();
  for (const g of groups) {
    let gsize = 0;
    for (const it of g) gsize += Math.max(1, it.size);
    while (cursor < spiral.length && !isFree(spiral[cursor][0], spiral[cursor][1])) {
      cursor++;
    }
    const anchor = spiral[cursor] ?? [0, 0];
    const blob = growBlob(anchor, gsize, isFree);
    for (const c of blob) occupied.add(axialKey(c[0], c[1]));
    reserveMoat(blob, moat, occupied, blocked);
    // Order the territory's cells by a serpentine (boustrophedon) row sweep
    // before handing them out, so sub-groups read as straight bands flowing
    // across the territory rather than the concentric rings a centre-out growth
    // order produces. Consecutive cells stay adjacent (row ends turn back), so
    // members remain contiguous.
    blob.sort(
      (a, b) => a[1] - b[1] || ((a[1] & 1) === 0 ? a[0] - b[0] : b[0] - a[0]),
    );
    // Hand out consecutive cells to each member (path order ??sub-neighbourhoods).
    let ci = 0;
    for (const it of g) {
      const want = Math.max(1, it.size);
      const cells = blob.slice(ci, ci + want);
      ci += cells.length;
      assign.set(it.name, cells);
    }
  }

  return items.map((it) => {
    const cells = assign.get(it.name) ?? [];
    return { name: it.name, size: cells.length, anchor: cells[0] ?? [0, 0], cells };
  });
}

// ?�?�?Affinity (force-directed) placement ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
//
// A different philosophy from placeDense: rather than packing every cell into a
// rigid centre-out honeycomb (whose outline is inevitably a big hexagon), we let
// territories find their own positions by *affinity*. Each territory is a node in
// a force simulation: it is attracted toward the centroid of every other
// territory that shares an attribute (same workload, same hub, same environment,
// ?? and repelled by all its neighbours so footprints don't overlap. Relaxing
// this system yields an organic, map-like arrangement ??regional continents of
// same-hub territories, with same-workload prod/dev islands sitting together ??
// with no imposed geometric envelope. Territories are then grown as contiguous
// blobs around their relaxed seeds, tessellating like countries on a coastline.
//
// Two "shared toward the centre" passes then reinforce the leaf-tissue read:
// within a region the most common territory (via `HierItem.central`) takes the
// innermost seed radius (a hub's connectivity subscription lands mid-lobe like a
// midrib), and within each blob the most shared resources are handed the cells
// nearest the blob centroid (the spoke network sits at the core of its areole).
//
// The layout is fully deterministic (golden-angle seeding + deterministic
// forces), so an identical estate always yields an identical map.

export interface AffinityOptions {
  /** Attraction weight per attribute position of `path` (leaf excluded); missing ??1. */
  attrWeights?: number[];
  /** Open-space factor (>1 spreads seeds, leaving organic gaps and coastline). */
  fill?: number;
}

interface AffGroup {
  attrs: string[];
  size: number;
  members: HierItem[];
  order: number;
}

/** Clamp a force component so a single step can't fling a node across the plane. */
function clampForce(v: number): number {
  return v < -3 ? -3 : v > 3 ? 3 : v;
}

/** Order members of a territory by their leaf key (then name) for stable sub-structure. */
function cmpLeaf(a: HierItem, b: HierItem): number {
  const la = a.path[a.path.length - 1] ?? a.name;
  const lb = b.path[b.path.length - 1] ?? b.name;
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Order members most "shared" first (higher `central`), then by leaf key ??so
 *  common infrastructure is handed the innermost cells of its cluster. */
function cmpCentral(a: HierItem, b: HierItem): number {
  const ca = a.central ?? 0;
  const cb = b.central ?? 0;
  if (ca !== cb) return cb - ca;
  return cmpLeaf(a, b);
}

/**
 * A territory's "shared-ness" ??how central it should sit in its region. A
 * cluster that *contains* shared/hub infrastructure (a Virtual WAN hub, Azure
 * Firewall, ExpressRoute or VNet gateway, DNS Private Resolver, ?? is itself a
 * shared hub, even when that infra is only a small fraction of its cells. So we
 * take the max of the size-weighted mean and a discounted *peak* member central:
 * the mean still ranks ordinary clusters by their average, while any cluster
 * holding a high-central resource is lifted near the top and pulled to the
 * centre of its hub ??instead of being diluted by many workload-specific leaves.
 */
function groupCentral(g: AffGroup): number {
  let s = 0;
  let w = 0;
  let peak = 0;
  for (const m of g.members) {
    const sz = Math.max(1, m.size);
    const c = m.central ?? 0;
    s += c * sz;
    w += sz;
    if (c > peak) peak = c;
  }
  const mean = w > 0 ? s / w : 0;
  return Math.max(mean, 0.85 * peak);
}

/** Return a blob's cells ordered nearest-first around its pixel centroid, so the
 *  first cells handed out land in the middle of the cluster (centre-out). */
function centreFirst(blob: Axial[]): Axial[] {
  if (blob.length <= 2) return blob.slice();
  let cx = 0;
  let cy = 0;
  for (const c of blob) {
    const [x, y] = axialToPixel(c[0], c[1], 1);
    cx += x;
    cy += y;
  }
  cx /= blob.length;
  cy /= blob.length;
  return blob
    .map((c) => {
      const [x, y] = axialToPixel(c[0], c[1], 1);
      const dx = x - cx;
      const dy = y - cy;
      return { c, d: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d - b.d || a.c[1] - b.c[1] || a.c[0] - b.c[0])
    .map((o) => o.c);
}

/** The nine spatial-hash cells to scan for a node's repulsion neighbours. */
const NEIGHBOR9: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 0], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

/** Apply mutual repulsion between nodes i and j (only once, when j > i).
 *  `nest` marks nodes allowed to sit *inside* a much larger neighbour instead of
 *  being pushed out of it ??see {@link relaxSiblings}. */
function repelPair(
  i: number,
  j: number,
  px: Float64Array,
  py: Float64Array,
  rad: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  strength: number,
  nest?: Uint8Array,
): void {
  if (j <= i) return;
  if (nest && ((nest[i] === 1 && rad[j] > 2 * rad[i]) || (nest[j] === 1 && rad[i] > 2 * rad[j]))) {
    return;
  }
  let dx = px[i] - px[j];
  let dy = py[i] - py[j];
  const minD = (rad[i] + rad[j]) * 1.05;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d >= minD) return;
  if (d < 1e-6) {
    dx = (i % 7) - 3 || 1;
    dy = (j % 5) - 2 || 1;
    d = Math.sqrt(dx * dx + dy * dy);
  }
  const push = ((minD - d) / d) * strength;
  fx[i] += dx * push;
  fy[i] += dy * push;
  fx[j] -= dx * push;
  fy[j] -= dy * push;
}

/** Short-range repulsion (via a spatial hash) that keeps territory footprints apart. */
function repelForces(
  px: Float64Array,
  py: Float64Array,
  rad: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  strength: number,
  nest?: Uint8Array,
): void {
  const n = px.length;
  // Small groups (a resource group's contents, a handful of clusters) are the
  // common case here and are called thousands of times ??the direct sweep beats
  // building a hash table per relaxation step.
  if (n <= 16) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) repelPair(i, j, px, py, rad, fx, fy, strength, nest);
    }
    return;
  }
  let avg = 0;
  for (let i = 0; i < n; i++) avg += rad[i];
  const cell = Math.max(1, (avg / (n || 1)) * 3);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = Math.floor(px[i] / cell) + ',' + Math.floor(py[i] / cell);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(px[i] / cell);
    const gy = Math.floor(py[i] / cell);
    for (const [ox, oy] of NEIGHBOR9) {
      const bucket = grid.get(gx + ox + ',' + (gy + oy));
      if (!bucket) continue;
      for (const j of bucket) repelPair(i, j, px, py, rad, fx, fy, strength, nest);
    }
  }
}

/** Comparator ordering a hub's territories for seeding: the most-shared workload
 *  first (so its connectivity subscription seeds nearest the hub centre), then
 *  keeping every workload's subscriptions adjacent so they grow into one areole
 *  rather than fragmenting once each territory is pinned to its own seed. */
function makeSeedOrder(groups: AffGroup[], central: number[]): (a: number, b: number) => number {
  const wlOf = (i: number): string => groups[i].attrs[1] ?? groups[i].attrs[0] ?? '';
  const wlCentral = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    const wk = wlOf(i);
    wlCentral.set(wk, Math.max(wlCentral.get(wk) ?? 0, central[i] ?? 0));
  }
  return (a, b) => {
    const ca = wlCentral.get(wlOf(a)) ?? 0;
    const cb = wlCentral.get(wlOf(b)) ?? 0;
    if (ca !== cb) return cb - ca;
    const ka = wlOf(a);
    const kb = wlOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return groups[b].size - groups[a].size || a - b;
  };
}

/** Seed territory positions: spread each hub's territories on a uniform-density
 *  sunflower disc and pin every one to its OWN seed (not the single hub centre),
 *  so the relaxation can't collapse them into a dense core ??the intra-hub gaps
 *  stay even from the middle out. Returns whether anchoring is in effect. */
function seedClusters(
  groups: AffGroup[],
  primary: Map<string, number[]>,
  r0: number,
  fill: number,
  ga: number,
  central: number[],
  px: Float64Array,
  py: Float64Array,
  anchorX: Float64Array,
  anchorY: Float64Array,
): boolean {
  const n = px.length;
  const order = makeSeedOrder(groups, central);
  if (primary.size <= 1) {
    const ranked = Array.from({ length: n }, (_, i) => i).sort(order);
    ranked.forEach((i, rank) => {
      const rr = r0 * fill * Math.sqrt((rank + 0.5) / n);
      const sx = Math.cos(rank * ga) * rr;
      const sy = Math.sin(rank * ga) * rr;
      px[i] = sx;
      py[i] = sy;
      anchorX[i] = sx;
      anchorY[i] = sy;
    });
    return true;
  }
  const pv = [...primary.keys()];
  pv.forEach((v, pi) => {
    const members = (primary.get(v) ?? []).slice().sort(order);
    let csize = 0;
    for (const i of members) csize += groups[i].size;
    const cr = r0 * fill * 0.68 * Math.sqrt((pi + 0.5) / pv.length);
    const cx = Math.cos(pi * ga) * cr;
    const cy = Math.sin(pi * ga) * cr;
    const local = Math.sqrt(Math.max(1, csize) / Math.PI);
    members.forEach((i, mi) => {
      const lr = local * Math.sqrt((mi + 0.5) / members.length);
      const sx = cx + Math.cos(mi * ga) * lr;
      const sy = cy + Math.sin(mi * ga) * lr;
      px[i] = sx;
      py[i] = sy;
      // Pin to the territory's OWN spread seed so same-hub territories keep an
      // even spacing instead of piling up at the hub centre.
      anchorX[i] = sx;
      anchorY[i] = sy;
    });
  });
  return true;
}

/** Relax territory seeds under attribute-affinity attraction + mutual repulsion. */
function affinitySeeds(
  groups: AffGroup[],
  weights: number[],
  fill: number,
): [number, number][] {
  const n = groups.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  if (n === 0) return [];
  let total = 0;
  for (const g of groups) total += g.size;
  const r0 = Math.sqrt(total / Math.PI);
  const ga = Math.PI * (3 - Math.sqrt(5)); // golden angle
  const rad = new Float64Array(n);
  for (let i = 0; i < n; i++) rad[i] = Math.sqrt(Math.max(1, groups[i].size) / Math.PI);

  // Size-weighted "shared-ness" per territory, used to pull common
  // infrastructure toward the centre of its region.
  const central = groups.map(groupCentral);

  // Attribute value ??member indices, one map per attribute position.
  const k = groups.reduce((m, g) => Math.max(m, g.attrs.length), 0);
  const dims: Map<string, number[]>[] = [];
  for (let d = 0; d < k; d++) {
    const m = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const v = groups[i].attrs[d];
      if (v === undefined) continue;
      const arr = m.get(v);
      if (arr) arr.push(i);
      else m.set(v, [i]);
    }
    dims.push(m);
  }

  // Hierarchical seeding + anchoring: the coarsest attribute (position 0 ??e.g.
  // the hub / region) forms primary clusters spread on a golden-angle spiral,
  // and each territory records that cluster centre as a fixed "anchor". The
  // relaxation below pulls territories toward their anchor rather than a moving
  // centroid, so regions keep their spread positions instead of collapsing into
  // a dense central pile (short-range repulsion alone can't keep distant
  // clusters apart). Finer attributes still use moving centroids for organic
  // sub-structure.
  const anchorX = new Float64Array(n);
  const anchorY = new Float64Array(n);
  const primary = dims.length > 0 ? dims[0] : new Map<string, number[]>();
  const anchored = seedClusters(groups, primary, r0, fill, ga, central, px, py, anchorX, anchorY);
  const iters = 140;
  const attract = 0.02;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  for (let t = 0; t < iters; t++) {
    fx.fill(0);
    fy.fill(0);
    // Primary attribute: pull toward the FIXED cluster anchors (keeps regions spread).
    const w0 = weights[0] ?? 1;
    if (anchored && w0 !== 0) {
      const kk = attract * w0;
      for (let i = 0; i < n; i++) {
        fx[i] += (anchorX[i] - px[i]) * kk;
        fy[i] += (anchorY[i] - py[i]) * kk;
      }
    }
    // Finer attributes: pull toward moving centroids for organic sub-structure.
    for (let d = anchored ? 1 : 0; d < k; d++) {
      const wd = weights[d] ?? 1;
      if (wd === 0) continue;
      for (const idx of dims[d].values()) {
        if (idx.length < 2) continue;
        let cx = 0;
        let cy = 0;
        for (const i of idx) {
          cx += px[i];
          cy += py[i];
        }
        cx /= idx.length;
        cy /= idx.length;
        const kk = attract * wd;
        for (const i of idx) {
          fx[i] += (cx - px[i]) * kk;
          fy[i] += (cy - py[i]) * kk;
        }
      }
    }
    repelForces(px, py, rad, fx, fy, 0.5);
    const step = 0.6 * (1 - t / iters) + 0.05;
    for (let i = 0; i < n; i++) {
      px[i] += clampForce(fx[i]) * step;
      py[i] += clampForce(fy[i]) * step;
    }
  }
  const out: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [px[i], py[i]];
  return out;
}

/** Outward spiral offsets, built once and shared by every outward search. */
let SEARCH_SPIRAL: Axial[] | null = null;
function searchSpiral(): Axial[] {
  if (SEARCH_SPIRAL === null) SEARCH_SPIRAL = hexSpiral(160);
  return SEARCH_SPIRAL;
}

/** Top up a stalled `blob` to `size` without ever eating a moat (`blocked`), so
 *  the inter-workload gap always survives. Rather than smearing the overflow
 *  along a ring (which reads as a thin tail), it grows the missing cells as a
 *  compact clump at the nearest free spot: the blob may fragment, but each piece
 *  keeps a natural rounded shape ??no contortion is done to avoid fragmenting. */
function fillShort(
  blob: Axial[],
  size: number,
  anchor: Axial,
  occupied: Set<string>,
  blocked: Set<string>,
): void {
  const free = (q: number, r: number): boolean => {
    const k = axialKey(q, r);
    return !occupied.has(k) && !blocked.has(k);
  };
  const offsets = searchSpiral();
  // Resume the outward scan where the last piece was found: the ground behind
  // the cursor has just been taken, and rescanning it is what made a stalled
  // blob cost more than the entire rest of the layout.
  let cursor = 1;
  let guard = 0;
  while (blob.length < size && guard++ < 4096) {
    let spot: Axial | null = null;
    while (cursor < offsets.length) {
      const q = anchor[0] + offsets[cursor][0];
      const r = anchor[1] + offsets[cursor][1];
      if (free(q, r)) {
        spot = [q, r];
        break;
      }
      cursor++;
    }
    if (!spot) break;
    const clump = growBlob(spot, size - blob.length, free);
    if (clump.length === 0) break;
    for (const c of clump) {
      occupied.add(axialKey(c[0], c[1]));
      blob.push(c);
    }
  }
}

/**
 * Affinity placement ??see the section comment above. `path` is read as an
 * attribute vector (coarsest first) followed by a leaf: territories are grouped
 * by the attribute vector, positioned by a force simulation that attracts
 * shared-attribute territories together, then grown as contiguous blobs around
 * their seeds. Deterministic; returns placements in input order.
 */
export function placeAffinity(items: HierItem[], opts: AffinityOptions = {}): PlacedWorkload[] {
  if (items.length === 0) return [];
  const weights = opts.attrWeights ?? [];
  const fill = opts.fill ?? 1.25;

  // Group by attribute vector (the path without its unique leaf element).
  const byKey = new Map<string, AffGroup>();
  const groups: AffGroup[] = [];
  for (const it of items) {
    const attrs = it.path.slice(0, Math.max(0, it.path.length - 1));
    const key = attrs.join('\u0001');
    let g = byKey.get(key);
    if (!g) {
      g = { attrs, size: 0, members: [], order: groups.length };
      byKey.set(key, g);
      groups.push(g);
    }
    g.size += Math.max(1, it.size);
    g.members.push(it);
  }

  const seeds = affinitySeeds(groups, weights, fill);
  let maxr = 1e-6;
  for (const [x, y] of seeds) maxr = Math.max(maxr, Math.hypot(x, y));
  let total = 0;
  for (const g of groups) total += g.size;
  const r0 = Math.sqrt(total / Math.PI);
  const scale = (r0 * fill * 1.95) / maxr; // seed units ??pixels; >1 leaves room for the veins
  const avgRad = Math.sqrt(total / (groups.length || 1) / Math.PI);
  const nudge = hexSpiral(Math.max(8, Math.ceil(4 * avgRad) + 6));

  // "Shared-ness" per territory. Growth order below grows the most shared blob (a
  // hub's connectivity subscription) first so it settles at the hub centre, then
  // largest-first so big blobs claim open space and don't stall into an expensive
  // fragmented fill.
  const gCentral = groups.map(groupCentral);

  const occupied = new Set<string>();
  const blocked = new Set<string>();
  const isFree = (q: number, r: number): boolean => {
    const key = axialKey(q, r);
    return !occupied.has(key) && !blocked.has(key);
  };
  const assign = new Map<string, Axial[]>();

  // Grow one subscription as a contiguous blob at its relaxed seed, then hand its
  // cells to members in resource-group (leaf) order for sub-structure.
  const growOne = (gi: number): Axial[] => {
    const g = groups[gi];
    const [sx, sy] = seeds[gi];
    const frac = pixelToAxial(sx * scale, sy * scale, 1);
    const base = hexRound(frac[0], frac[1]);
    // Anchor at the seed (nudged to the first free cell). If the blob can't reach
    // its full size here it simply fragments ??`fillShort` reclaims only the soft
    // sub-gaps beside it (never a hard inter-workload moat), so the gap survives
    // and no contorted search is done to keep the blob in one piece.
    let anchor: Axial = base;
    for (const off of nudge) {
      if (isFree(base[0] + off[0], base[1] + off[1])) {
        anchor = [base[0] + off[0], base[1] + off[1]];
        break;
      }
    }
    const blob = growBlob(anchor, g.size, isFree);
    for (const c of blob) occupied.add(axialKey(c[0], c[1]));
    if (blob.length < g.size) fillShort(blob, g.size, anchor, occupied, blocked);
    // Hand cells out centre-first, most "shared" members first, so common
    // infrastructure (e.g. the spoke network) occupies the middle of the blob.
    const cells = centreFirst(blob);
    const mem = g.members.slice().sort(cmpCentral);
    let ci = 0;
    for (const it of mem) {
      const want = Math.max(1, it.size);
      assign.set(it.name, cells.slice(ci, ci + want));
      ci += want;
    }
    return blob;
  };

  // Graduated empty channels read as leaf venation: thick veins between hubs,
  // medium between workloads, thin between subscriptions ??with the hex cells as
  // the smallest tissue filling each subscription areole. Growth is nested
  // (hub ??workload ??subscription) so each level's region is one contiguous
  // areole ringed by a vein of its level's width.
  const W_SUB = 1;
  const W_WL = 2;
  const W_HUB = 4;
  const sizeOf = (idxs: number[]): number => idxs.reduce((s, i) => s + groups[i].size, 0);

  // Grow a set of subscriptions (largest first), each ringed by a thin vein;
  // returns their combined cells so a parent vein can ring the whole group.
  const growSubs = (subIdxs: number[]): Axial[] => {
    const cells: Axial[] = [];
    // Most-shared first (connectivity ??centre), then largest-first into open space.
    const ordered = subIdxs
      .slice()
      .sort(
        (a, b) =>
          gCentral[b] - gCentral[a] || groups[b].size - groups[a].size || groups[a].order - groups[b].order,
      );
    for (const gi of ordered) {
      const blob = growOne(gi);
      reserveMoat(blob, W_SUB, occupied, blocked);
      for (const c of blob) cells.push(c);
    }
    return cells;
  };

  // Build the hub ??workload hierarchy from the attribute vector.
  const hubs: { wls: Map<string, number[]>; order: number }[] = [];
  const hubIndex = new Map<string, number>();
  groups.forEach((g, i) => {
    const hk = g.attrs[0] ?? '';
    let hi = hubIndex.get(hk);
    if (hi === undefined) {
      hi = hubs.length;
      hubIndex.set(hk, hi);
      hubs.push({ wls: new Map(), order: hi });
    }
    const wk = g.attrs[1] ?? '';
    const arr = hubs[hi].wls.get(wk);
    if (arr) arr.push(i);
    else hubs[hi].wls.set(wk, [i]);
  });
  const hubSize = (h: { wls: Map<string, number[]> }): number => {
    let s = 0;
    for (const arr of h.wls.values()) s += sizeOf(arr);
    return s;
  };
  hubs.sort((a, b) => hubSize(b) - hubSize(a) || a.order - b.order);

  const wlCentral = (idxs: number[]): number => idxs.reduce((m, i) => Math.max(m, gCentral[i]), 0);
  for (const hub of hubs) {
    const hubCells: Axial[] = [];
    // Most-shared workload (connectivity) first so it lands at the hub centre,
    // then largest-first so big blobs grow into open space without stalling.
    const wlKeys = [...hub.wls.keys()].sort((a, b) => {
      const ga = hub.wls.get(a) ?? [];
      const gb = hub.wls.get(b) ?? [];
      return wlCentral(gb) - wlCentral(ga) || sizeOf(gb) - sizeOf(ga) || (a < b ? -1 : 1);
    });
    for (const wk of wlKeys) {
      const wlCells = growSubs(hub.wls.get(wk) ?? []);
      reserveMoat(wlCells, W_WL, occupied, blocked);
      for (const c of wlCells) hubCells.push(c);
    }
    reserveMoat(hubCells, W_HUB, occupied, blocked);
  }

  return items.map((it) => {
    const cells = assign.get(it.name) ?? [];
    return { name: it.name, size: cells.length, anchor: cells[0] ?? [0, 0], cells };
  });
}

// ?�?�?Relational placement: nested containment + magnetic links ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
//
// An Azure estate has two shapes at once. The first is *containment* ??a
// management group holds subscriptions, a subscription holds resource groups, a
// resource group holds resources ??a strict tree that governance really
// enforces. The second is the *relationship graph* that cuts straight across
// it: a NIC is attached to a VM and to a subnet, a disk to a VM, and a spoke
// VNet peers with a Virtual WAN hub that lives in another subscription under
// another management group entirely.
//
// This placement draws both. Containment is a hard wall: every cluster grows as
// one contiguous blob ringed by an empty moat that widens with the level, so a
// resource can never drift out of its resource group, nor a resource group out
// of its subscription. Inside those walls nothing is prescribed ??a force model
// decides: linked resources attract like iron filings around a magnet, unlinked
// ones repel, and whatever a cluster shares with the rest of the estate is
// drawn toward its middle.
//
// Links that cross a wall are not dropped. They pull their endpoint toward the
// side of the cluster facing the far end, and ??at the level where the two
// clusters part company ??pull the clusters themselves together. That single
// rule reproduces the estate's real gravity for free: spoke VNets settle on the
// hub-facing rim of their subscription, a region's subscriptions gather around
// the hub they peer with, and the shared connectivity subscription, linked to
// everything, ends up in the middle of everything it serves.
//
// Deterministic: identical input always yields an identical map.

/** One resource to place: where it lives (containment) and what it is wired to. */
export interface RelItem {
  name: string;
  /** Cells this item occupies. Default 1. */
  size?: number;
  /** Containment path, coarsest first (e.g. [mgRoot, mgChild, subscription, resourceGroup]). */
  path: string[];
  /** Names of related items ??the magnetic links. Symmetric; unknown names are ignored. */
  deps?: string[];
  /** Shared-ness 0..1 ??higher is drawn toward the centre of its cluster. */
  central?: number;
  /** Non-containment attributes (e.g. [region, workload]) whose siblings attract. */
  affinity?: string[];
}

export interface RelationalOptions {
  /** Empty-cell gap ringing a cluster at each containment depth, coarsest first. */
  moats?: number[];
  /** Attraction weight per `affinity` slot. Default none (its length sets the slot count). */
  affinityWeights?: number[];
}

// A laid-out estate is worth keeping. Recomputing it costs seconds, but the real
// reason to persist it is that a monitoring wall is only useful once operators
// build a spatial memory of it — "payments is always bottom-left" — and this is
// a packing, so adding a single resource shifts everything after it. A saved
// layout keeps the map still, and lets it be baked once and shared rather than
// recomputed per browser (which would give every operator a different map).

/** Bump whenever the algorithm's output changes, so old snapshots are rejected. */
export const PLACEMENT_VERSION = 2;

export interface PlacementSnapshot {
  version: number;
  /** Fingerprint of the inputs this layout was built from. */
  key: string;
  /** Resource name → flattened cell coordinates [q0, r0, q1, r1, …]. */
  cells: Record<string, number[]>;
}

/** Fingerprint of everything the layout depends on — the resources, what they are
 *  wired to, the options, and which algorithm drew it. Anything left out here
 *  shows up as a stale map. */
export function placementKey(
  items: RelItem[],
  opts: RelationalOptions = {},
  mode = 'relational',
): string {
  let h = hashString(
    `v${PLACEMENT_VERSION}|${mode}|${(opts.moats ?? []).join(',')}|${(opts.affinityWeights ?? []).join(',')}`,
  );
  for (const it of items) {
    h = hashString(
      `${h}|${it.name}|${it.size ?? 1}|${it.path.join('\u0001')}|` +
        `${(it.deps ?? []).join(',')}|${it.central ?? 0}|${(it.affinity ?? []).join('\u0001')}`,
    );
  }
  return h.toString(36);
}

export function serializePlacement(placed: PlacedWorkload[], key: string): PlacementSnapshot {
  const cells: Record<string, number[]> = {};
  for (const p of placed) {
    const flat = new Array<number>(p.cells.length * 2);
    for (let i = 0; i < p.cells.length; i++) {
      flat[i * 2] = p.cells[i][0];
      flat[i * 2 + 1] = p.cells[i][1];
    }
    cells[p.name] = flat;
  }
  return { version: PLACEMENT_VERSION, key, cells };
}

/** Rebuild a placement from a snapshot, in input order. Returns null if anything
 *  at all fails to line up, so the caller simply lays the estate out again. */
export function restorePlacement(
  snap: PlacementSnapshot | null | undefined,
  items: RelItem[],
  key: string,
): PlacedWorkload[] | null {
  if (!snap || snap.version !== PLACEMENT_VERSION || snap.key !== key) return null;
  const out: PlacedWorkload[] = [];
  for (const it of items) {
    const flat = snap.cells[it.name];
    if (flat === undefined || flat.length % 2 !== 0) return null;
    const cells: Axial[] = new Array(flat.length / 2);
    for (let i = 0; i < cells.length; i++) cells[i] = [flat[i * 2], flat[i * 2 + 1]];
    out.push({ name: it.name, size: cells.length, anchor: cells[0] ?? [0, 0], cells });
  }
  return out;
}

/** Area of a unit-circumradius pointy-top hexagon, in the pixel units `axialToPixel` uses. */
const HEX_AREA = (3 * Math.sqrt(3)) / 2;
/** Distance between adjacent hex centres ??how much radius one moat cell adds. */
const MOAT_PITCH = Math.sqrt(3);
/** Discs can't tile, but the blobs grown from them can. Circle packing leaves
 *  ~25% of a parent empty, so the radius a sibling group settles at is pulled
 *  back by this much ??the blobs interlock and take up the slack. Without it the
 *  loss compounds at every level and the estate spreads into dust. */
const TESSELLATION_GAIN = 0.7;
/** Force-relaxation sweeps per sibling group. */
const RELAX_ITERS = 120;

/** Radius of a disc that exactly holds `cells` hexes. */
function tightRadius(cells: number): number {
  return Math.sqrt((Math.max(1, cells) * HEX_AREA) / Math.PI);
}

/** A containment cluster: one management group, subscription, resource group, ??*/
interface RNode {
  id: number;
  depth: number;
  /** Position among its siblings in input order (stable tie-break). */
  order: number;
  parent: RNode | null;
  children: RNode[];
  /** Item indices ??only the deepest clusters hold them. */
  items: number[];
  /** Cells its subtree needs. */
  size: number;
  /** Shared-ness, aggregated from its members. */
  central: number;
  /** Affinity value per slot, or null where its members disagree. */
  affinity: (string | null)[];
  /** Absolute seed position, in hex-pixel units. */
  x: number;
  y: number;
  /** Radius of the disc its children are laid out in. */
  r: number;
  /** Radius including the moat that will ring it ??what siblings must keep clear. */
  rOuter: number;
  /** Order index of the child that every other child is wired to ??the centre of
   *  a hub and its spokes ??or -1 when this cluster is not a star. */
  star: number;
  // Running accumulators used while aggregating `central`.
  cSum: number;
  cWeight: number;
  cPeak: number;
  affSeen: boolean;
}

/** An attraction between two indices (items, or siblings within one parent). */
interface RLink {
  a: number;
  b: number;
  w: number;
}

function newRNode(id: number, depth: number, order: number, parent: RNode | null): RNode {
  return {
    id,
    depth,
    order,
    parent,
    children: [],
    items: [],
    size: 0,
    central: 0,
    affinity: [],
    x: 0,
    y: 0,
    r: 0,
    rOuter: 0,
    star: -1,
    cSum: 0,
    cWeight: 0,
    cPeak: 0,
    affSeen: false,
  };
}

/** Fold one member into a cluster's aggregates: size, shared-ness, and the
 *  affinity values its members still agree on (a disagreement blanks the slot). */
function absorb(node: RNode, it: RelItem, size: number): void {
  node.size += size;
  const c = it.central ?? 0;
  node.cSum += c * size;
  node.cWeight += size;
  if (c > node.cPeak) node.cPeak = c;
  const aff = it.affinity ?? [];
  if (!node.affSeen) {
    node.affinity = aff.slice();
    node.affSeen = true;
    return;
  }
  for (let s = 0; s < node.affinity.length; s++) {
    if (node.affinity[s] !== null && node.affinity[s] !== (aff[s] ?? null)) node.affinity[s] = null;
  }
}

/** Build the containment tree, returning every cluster plus each item's ancestor chain. */
function buildRTree(
  items: RelItem[],
  depth: number,
): { root: RNode; nodes: RNode[]; anc: RNode[][] } {
  const nodes: RNode[] = [];
  const root = newRNode(-1, -1, 0, null);
  const byKey = new Map<string, RNode>();
  const anc: RNode[][] = new Array(items.length);
  items.forEach((it, i) => {
    const size = Math.max(1, it.size ?? 1);
    const chain: RNode[] = new Array(depth);
    let node = root;
    let key = '';
    for (let d = 0; d < depth; d++) {
      // Short paths repeat their last segment, so every item lands at full depth.
      const seg = it.path[d] ?? it.path[it.path.length - 1] ?? it.name;
      key = d === 0 ? seg : key + '\u0001' + seg;
      let child = byKey.get(key);
      if (!child) {
        child = newRNode(nodes.length, d, node.children.length, node);
        nodes.push(child);
        byKey.set(key, child);
        node.children.push(child);
      }
      absorb(child, it, size);
      chain[d] = child;
      node = child;
    }
    node.items.push(i);
    anc[i] = chain;
    absorb(root, it, size);
  });
  for (const n of nodes) {
    const mean = n.cWeight > 0 ? n.cSum / n.cWeight : 0;
    // A cluster that merely *contains* hub infrastructure is itself a hub, so a
    // discounted peak keeps it from being diluted by many ordinary members.
    n.central = Math.max(mean, 0.85 * n.cPeak);
  }
  return { root, nodes, anc };
}

/**
 * Sizing pass, bottom-up: pack each node's children by repulsion alone and adopt
 * the radius they actually settle at. Modelling the disc from an area budget
 * cannot predict how unequal circles pack, and guessing even slightly small is
 * fatal here ??the positioning pass would squeeze the children back inside a
 * disc they don't fit in, seeds would land on ground the previous sibling has
 * already taken, and nearly every blob would stall.
 */
function sizeTree(node: RNode, moats: number[], affinityWeights: number[]): void {
  const kids = node.children;
  if (kids.length === 0) {
    node.r = tightRadius(node.size);
  } else {
    for (const c of kids) sizeTree(c, moats, affinityWeights);
    const n = kids.length;
    const rad = new Float64Array(n);
    const central = new Float64Array(n);
    const weight = new Float64Array(n);
    const aff: (string | null)[][] = new Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) {
      rad[i] = kids[i].rOuter;
      central[i] = kids[i].central;
      weight[i] = kids[i].size;
      aff[i] = kids[i].affinity;
      area += rad[i] * rad[i];
    }
    // Radius of a disc whose area equals the children's — the tightest they
    // could ever sit; the relaxation below settles at a realistic spread.
    const seedR = Math.sqrt(area);
    const zero = new Float64Array(n);
    const { reach } = relaxSiblings(
      rad, central, weight, [], zero, zero, zero, aff, affinityWeights, seedR, false, 0.06,
      node.star,
    );
    node.r =
      node.star >= 0
        ? // A wheel is already as tight as it goes; interlocking cannot take up
          // the slack between its spokes, and shaving the radius would only make
          // the positioning pass squeeze them back into each other.
          Math.max(seedR, reach)
        : Math.max(seedR, reach * TESSELLATION_GAIN);
  }
  node.rOuter = node.r + MOAT_PITCH * (moats[node.depth] ?? 0);
}

/** Seed sibling positions, most-shared (then largest) first, spiralling outward
 *  by *area* rather than by rank: sibling sizes here differ by orders of
 *  magnitude (a platform enclave beside a landing-zone continent) and a
 *  rank-spaced sunflower would strand the giant off-centre. A sibling that
 *  dominates its parent's area can only be in the middle ??nothing else would
 *  fit around it ??so it is pinned there and the rest spiral outside it. */
function sunflowerPlace(
  ranked: number[],
  areaOf: (i: number) => number,
  R: number,
  set: (i: number, x: number, y: number) => void,
): void {
  let total = 0;
  for (const i of ranked) total += areaOf(i);
  const ga = Math.PI * (3 - Math.sqrt(5)); // golden angle
  let cum = 0;
  ranked.forEach((i, rank) => {
    const a = areaOf(i);
    const rr = a > 0.4 * total ? 0 : R * Math.sqrt((cum + a / 2) / Math.max(1e-9, total));
    cum += a;
    set(i, Math.cos(rank * ga) * rr, Math.sin(rank * ga) * rr);
  });
}

/**
 * Seed sibling positions, most-shared (then largest) first, nesting the spiral
 * by affinity: the regions spiral out from the centre, each region's workloads
 * spiral inside it, and their subscriptions inside that. This is what decides
 * whether the map reads by relatedness at all — a flat spiral scatters a
 * region's subscriptions across the whole estate, and no attraction can reel
 * them back in afterwards without also crushing everything into the middle.
 * Groups keep the priority order of their best member, so a region's shared
 * connectivity lands in its core rather than out on the rim.
 */
function seedSiblings(
  members: number[],
  slot: number,
  slots: number,
  affinity: (string | null)[][],
  rad: Float64Array,
  R: number,
  cx: number,
  cy: number,
  px: Float64Array,
  py: Float64Array,
): void {
  const areaOf = (i: number): number => rad[i] * rad[i];
  const place = (): void =>
    sunflowerPlace(members, areaOf, R, (i, x, y) => {
      px[i] = cx + x;
      py[i] = cy + y;
    });
  if (slot >= slots || members.length <= 1) {
    place();
    return;
  }
  const byVal = new Map<string, number[]>();
  const loose: number[] = [];
  for (const i of members) {
    const v = affinity[i]?.[slot];
    if (v === null || v === undefined) {
      loose.push(i);
      continue;
    }
    const arr = byVal.get(v);
    if (arr) arr.push(i);
    else byVal.set(v, [i]);
  }
  if (byVal.size < 2) {
    seedSiblings(members, slot + 1, slots, affinity, rad, R, cx, cy, px, py);
    return;
  }
  const groups = [...byVal.values()];
  for (const i of loose) groups.push([i]);
  const gArea = groups.map((g) => g.reduce((s, i) => s + areaOf(i), 0));
  const gIdx = groups.map((_, gi) => gi);
  const gx = new Float64Array(groups.length);
  const gy = new Float64Array(groups.length);
  sunflowerPlace(gIdx, (gi) => gArea[gi], R, (gi, x, y) => {
    gx[gi] = x;
    gy[gi] = y;
  });
  // The spiral spaces group *centres* over the disc, so the outer groups would
  // hang off its rim; pull them back in until the groups themselves fit.
  let spread = 0;
  for (const gi of gIdx) spread = Math.max(spread, Math.hypot(gx[gi], gy[gi]) + Math.sqrt(gArea[gi]));
  const s = spread > R && spread > 1e-9 ? R / spread : 1;
  for (const gi of gIdx) {
    seedSiblings(
      groups[gi],
      slot + 1,
      slots,
      affinity,
      rad,
      Math.sqrt(gArea[gi]) * s,
      cx + gx[gi] * s,
      cy + gy[gi] * s,
      px,
      py,
    );
  }
}

/** Mark siblings allowed to sit *inside* a much larger neighbour instead of
 *  being shoved out of it. Such a cluster is grown first, claiming the middle,
 *  and the big one then grows around its moat ??which is how the shared platform
 *  lands as an enclave in the core of the landing zones. */
function nestFlags(central: Float64Array, rad: Float64Array): Uint8Array {
  const n = rad.length;
  const nest = new Uint8Array(n);
  let maxC = 0;
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    if (central[i] > maxC) maxC = central[i];
    if (rad[i] > maxR) maxR = rad[i];
  }
  for (let i = 0; i < n; i++) {
    nest[i] = central[i] >= maxC - 0.05 && rad[i] < 0.5 * maxR ? 1 : 0;
  }
  return nest;
}

/** Affinity slot ??value ??members, so a shared attribute pulls its group together. */
function affinityDims(
  affinity: (string | null)[][],
  slots: number,
  n: number,
): Map<string, number[]>[] {
  const dims: Map<string, number[]>[] = [];
  for (let s = 0; s < slots; s++) {
    const m = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const v = affinity[i]?.[s];
      if (v === null || v === undefined) continue;
      const arr = m.get(v);
      if (arr) arr.push(i);
      else m.set(v, [i]);
    }
    dims.push(m);
  }
  return dims;
}

/** Per-node forces: hold your own seed, and lean toward whatever you are wired
 *  to outside the parent. */
function applyNodeForces(
  px: Float64Array,
  py: Float64Array,
  anchorX: Float64Array,
  anchorY: Float64Array,
  ext: { x: Float64Array; y: Float64Array; w: Float64Array },
  fx: Float64Array,
  fy: Float64Array,
): void {
  for (let i = 0; i < px.length; i++) {
    // Its own spread seed — without this the whole group collapses inward.
    fx[i] += (anchorX[i] - px[i]) * 0.025;
    fy[i] += (anchorY[i] - py[i]) * 0.025;
    const w = ext.w[i];
    if (w > 0) {
      // Links out of the parent: drift toward the wall facing the far cluster.
      const k = 0.05 * (w / (w + 1));
      fx[i] += (ext.x[i] / w - px[i]) * k;
      fy[i] += (ext.y[i] / w - py[i]) * k;
    }
  }
}

/** Pull each affinity group toward its own centroid, and record where the
 *  coarsest attribute — slot 0, the region — put each node's group. Shared
 *  infrastructure then sinks toward the middle of *its own* group rather than
 *  the middle of the map, which is what puts a hub at the core of its region. */
function applyAffinityForces(
  px: Float64Array,
  py: Float64Array,
  dims: Map<string, number[]>[],
  affinityWeights: number[],
  fx: Float64Array,
  fy: Float64Array,
  homeX: Float64Array,
  homeY: Float64Array,
): void {
  homeX.fill(0);
  homeY.fill(0);
  for (let s = 0; s < dims.length; s++) {
    const wd = affinityWeights[s] ?? 1;
    for (const idx of dims[s].values()) {
      if (idx.length < 2) continue;
      let cx = 0;
      let cy = 0;
      for (const i of idx) {
        cx += px[i];
        cy += py[i];
      }
      cx /= idx.length;
      cy /= idx.length;
      if (s === 0) {
        for (const i of idx) {
          homeX[i] = cx;
          homeY[i] = cy;
        }
      }
      if (wd === 0) continue;
      const kk = 0.02 * wd;
      for (const i of idx) {
        fx[i] += (cx - px[i]) * kk;
        fy[i] += (cy - py[i]) * kk;
      }
    }
  }
}

/** Shift a relaxed group back onto its parent's centre. Links leaving the parent
 *  drag the whole group off to one side; without this that drift alone would
 *  force the arrangement to be squeezed to fit. */
function recentre(px: Float64Array, py: Float64Array, rad: Float64Array): void {
  const n = px.length;
  let cx = 0;
  let cy = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const a = rad[i] * rad[i];
    cx += px[i] * a;
    cy += py[i] * a;
    wsum += a;
  }
  if (wsum <= 0) return;
  cx /= wsum;
  cy /= wsum;
  for (let i = 0; i < n; i++) {
    px[i] -= cx;
    py[i] -= cy;
  }
}

/**
 * Find the child every other child is wired to — a Virtual WAN hub among the
 * subscriptions peered with it — or -1 when this level is an ordinary crowd.
 * A star is a shape the estate genuinely has, and it is worth drawing as one:
 * relaxation can only ever find a blob, because a blob is what minimises the
 * forces. The test is deliberately strict — half the siblings must point at the
 * same one, and nothing else may come close — so a merely well-connected member
 * of a normal cluster does not hijack the layout.
 */
function findStar(n: number, links: RLink[]): number {
  if (n < 6) return -1;
  const deg = new Int32Array(n);
  for (const l of links) {
    deg[l.a]++;
    deg[l.b]++;
  }
  let hub = -1;
  let best = 0;
  let second = 0;
  for (let i = 0; i < n; i++) {
    if (deg[i] > best) {
      second = best;
      best = deg[i];
      hub = i;
    } else if (deg[i] > second) {
      second = deg[i];
    }
  }
  if (best < Math.max(4, (n - 1) * 0.5)) return -1;
  if (best < second * 3) return -1;
  return hub;
}

/**
 * Seed a star: the hub at the origin, its spokes ringed around it at even
 * angles, ring by ring outward. Spokes keep the caller's order within a ring, so
 * an order grouped by affinity comes out as contiguous arcs — the management
 * groups read as sectors of the wheel rather than being scattered around it.
 * Returns the reach of the arrangement.
 */
function starSeed(
  hub: number,
  ranked: number[],
  rad: Float64Array,
  px: Float64Array,
  py: Float64Array,
): number {
  px[hub] = 0;
  py[hub] = 0;
  const gap = MOAT_PITCH;
  let inner = rad[hub] + gap;
  let reach = rad[hub];
  let ring = 0;
  for (let i = 0; i < ranked.length; ) {
    // The ring clears the previous one, and holds as many spokes as fit around
    // it at the width of its widest member.
    let rMax = 0;
    for (let j = i; j < ranked.length; j++) rMax = Math.max(rMax, rad[ranked[j]]);
    const ringR = inner + rMax;
    const half = Math.asin(Math.min(1, (rMax + gap * 0.5) / Math.max(ringR, 1e-9)));
    const capacity = Math.max(1, Math.floor(Math.PI / Math.max(half, 1e-6)));
    const count = Math.min(capacity, ranked.length - i);
    // Successive rings are offset half a step, so spokes sit in each other's gaps.
    const offset = (ring & 1) === 0 ? 0 : Math.PI / count;
    let widest = 0;
    for (let j = 0; j < count; j++, i++) {
      const s = ranked[i];
      const a = (2 * Math.PI * j) / count + offset;
      px[s] = Math.cos(a) * ringR;
      py[s] = Math.sin(a) * ringR;
      widest = Math.max(widest, rad[s]);
      reach = Math.max(reach, ringR + rad[s]);
    }
    inner = ringR + widest + gap;
    ring++;
  }
  return reach;
}

/** Force-relax one sibling group inside a disc of radius `parentR`, returning
 *  positions relative to the parent's centre. Shared members seed (and stay)
 *  near the middle, links pull siblings together, links leaving the parent pull
 *  their owner toward that side, and footprints repel so nothing piles up. */
function relaxSiblings(
  rad: Float64Array,
  central: Float64Array,
  weight: Float64Array,
  links: RLink[],
  extX: Float64Array,
  extY: Float64Array,
  extW: Float64Array,
  affinity: (string | null)[][],
  affinityWeights: number[],
  parentR: number,
  normalize = true,
  linkK = 0.06,
  star = -1,
): { px: Float64Array; py: Float64Array; reach: number } {
  const n = rad.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  if (n <= 1) return { px, py, reach: n === 1 ? rad[0] : 0 };

  const dims = affinityDims(affinity, affinityWeights.length, n);

  // A hub and its spokes is a shape, not a packing problem: ring it and leave it
  // alone, since relaxing it would only chew the wheel back into a blob.
  if (star >= 0) {
    // Spokes go round grouped by their coarsest affinity, largest group first,
    // so each management group takes a contiguous arc instead of being sprayed
    // around the wheel; inside an arc the biggest sit first.
    const spokes = Array.from({ length: n }, (_, i) => i).filter((i) => i !== star);
    const key = (i: number): string => affinity[i]?.[0] ?? '';
    const groupSize = new Map<string, number>();
    for (const i of spokes) groupSize.set(key(i), (groupSize.get(key(i)) ?? 0) + 1);
    spokes.sort(
      (a, b) =>
        (groupSize.get(key(b)) ?? 0) - (groupSize.get(key(a)) ?? 0) ||
        (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) ||
        rad[b] - rad[a] ||
        a - b,
    );
    const reach = starSeed(star, spokes, rad, px, py);
    if (normalize && reach > parentR && reach > 1e-9) {
      const s = parentR / reach;
      for (let i = 0; i < n; i++) {
        px[i] *= s;
        py[i] *= s;
      }
      return { px, py, reach: parentR };
    }
    return { px, py, reach };
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => central[b] - central[a] || weight[b] - weight[a] || a - b,
  );
  seedSiblings(order, 0, affinityWeights.length, affinity, rad, parentR, 0, 0, px, py);
  const anchorX = px.slice();
  const anchorY = py.slice();
  const nest = nestFlags(central, rad);

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const homeX = new Float64Array(n);
  const homeY = new Float64Array(n);
  const ext = { x: extX, y: extY, w: extW };
  // Tiny groups settle almost immediately; only crowded levels need the full sweep.
  const iters = n <= 4 ? 40 : n <= 16 ? 70 : RELAX_ITERS;
  for (let t = 0; t < iters; t++) {
    fx.fill(0);
    fy.fill(0);
    applyNodeForces(px, py, anchorX, anchorY, ext, fx, fy);
    applyAffinityForces(px, py, dims, affinityWeights, fx, fy, homeX, homeY);
    for (let i = 0; i < n; i++) {
      const c = central[i];
      if (c <= 0) continue;
      fx[i] += (homeX[i] - px[i]) * 0.05 * c;
      fy[i] += (homeY[i] - py[i]) * 0.05 * c;
    }
    for (const l of links) {
      // Saturating: the first wire already binds, a hundred shouldn't fuse them.
      const k = linkK * (l.w / (l.w + 1));
      const dx = px[l.b] - px[l.a];
      const dy = py[l.b] - py[l.a];
      fx[l.a] += dx * k;
      fy[l.a] += dy * k;
      fx[l.b] -= dx * k;
      fy[l.b] -= dy * k;
    }
    repelForces(px, py, rad, fx, fy, 0.5, nest);
    const step = 0.6 * (1 - t / iters) + 0.05;
    for (let i = 0; i < n; i++) {
      px[i] += clampForce(fx[i]) * step;
      py[i] += clampForce(fy[i]) * step;
    }
  }

  // Links leaving the parent drag the whole group off-centre; recentre before
  // measuring, so that drift alone doesn't force the arrangement to be squeezed.
  if (normalize) recentre(px, py, rad);
  // Containment: shrink the relaxed group until it fits inside its parent's disc.
  let reach = 0;
  for (let i = 0; i < n; i++) {
    // A nested sibling is meant to overlap its host, so it never sets the reach.
    if (nest[i] === 1) continue;
    reach = Math.max(reach, Math.hypot(px[i], py[i]) + rad[i]);
  }
  if (normalize && reach > parentR && reach > 1e-9) {
    const s = parentR / reach;
    for (let i = 0; i < n; i++) {
      px[i] *= s;
      py[i] *= s;
    }
    reach = parentR;
  }
  return { px, py, reach };
}

/** Lay out one parent's children and write their absolute positions. */
function layoutChildren(
  parent: RNode,
  links: RLink[],
  extX: Float64Array,
  extY: Float64Array,
  extW: Float64Array,
  affinityWeights: number[],
): void {
  const kids = parent.children;
  const n = kids.length;
  if (n === 0) return;
  const rad = new Float64Array(n);
  const central = new Float64Array(n);
  const weight = new Float64Array(n);
  const aff: (string | null)[][] = new Array(n);
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = kids[i];
    rad[i] = k.rOuter;
    central[i] = k.central;
    weight[i] = k.size;
    aff[i] = k.affinity;
    // External targets are absolute; the relaxation works in parent-local space.
    const w = extW[k.id];
    lw[i] = w;
    lx[i] = extX[k.id] - parent.x * w;
    ly[i] = extY[k.id] - parent.y * w;
  }
  const { px, py } = relaxSiblings(
    rad, central, weight, links, lx, ly, lw, aff, affinityWeights, parent.r, true, 0.06,
    parent.star,
  );
  for (let i = 0; i < n; i++) {
    kids[i].x = parent.x + px[i];
    kids[i].y = parent.y + py[i];
  }
}

/** Fold one crossing edge into the level's forces: clusters that share a parent
 *  attract each other, while an edge into another parent's subtree becomes a
 *  directional tug toward whatever is already positioned over there. */
function addLevelEdge(
  A: RNode,
  B: RNode,
  w: number,
  pass: number,
  byParent: Map<number, Map<string, RLink>>,
  ext: { x: Float64Array; y: Float64Array; w: Float64Array },
): void {
  if (A.parent === B.parent) {
    const pid = A.parent?.id ?? -1;
    let m = byParent.get(pid);
    if (!m) {
      m = new Map();
      byParent.set(pid, m);
    }
    const lo = Math.min(A.order, B.order);
    const hi = Math.max(A.order, B.order);
    const key = `${lo}:${hi}`;
    const cur = m.get(key);
    if (cur) cur.w += w;
    else m.set(key, { a: lo, b: hi, w });
    return;
  }
  // Pass 0 can only aim at the far *parent* ??the finest thing positioned so
  // far; pass 1 re-aims at the far cluster itself, now that it has a position.
  const aim = (from: RNode, to: RNode | null): void => {
    if (!to) return;
    ext.x[from.id] += to.x * w;
    ext.y[from.id] += to.y * w;
    ext.w[from.id] += w;
  };
  aim(A, pass === 0 ? B.parent : B);
  aim(B, pass === 0 ? A.parent : A);
}

/**
 * Relational placement ??see the section comment above. `path` is the
 * containment tree (coarsest first) and `deps` the relationship graph: clusters
 * nest as contiguous blobs walled off by per-level moats, while the links
 * arrange their contents inside those walls. Returns placements in input order.
 */
export function placeRelational(items: RelItem[], opts: RelationalOptions = {}): PlacedWorkload[] {
  if (items.length === 0) return [];
  let depth = 1;
  for (const it of items) if (it.path.length > depth) depth = it.path.length;
  const moats = opts.moats ?? Array.from({ length: depth }, (_, d) => Math.max(1, depth - d - 1));
  const affinityWeights = opts.affinityWeights ?? [];

  const { root, nodes, anc } = buildRTree(items, depth);

  // Resolve `deps` into a deduplicated, symmetric edge list over item indices.
  const indexOf = new Map<string, number>();
  items.forEach((it, i) => indexOf.set(it.name, i));
  const edges: RLink[] = [];
  const seenEdge = new Set<string>();
  items.forEach((it, i) => {
    for (const dep of it.deps ?? []) {
      const j = indexOf.get(dep);
      if (j === undefined || j === i) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ a: i, b: j, w: 1 });
    }
  });

  // Some levels are a star rather than a crowd: one cluster that every other
  // cluster is wired to. Spot them before sizing, so a Virtual WAN hub's own
  // territory is reserved as the wheel it will be drawn as.
  for (let d = 0; d < depth; d++) {
    const byParent = new Map<number, Set<string>>();
    for (const e of edges) {
      const A = anc[e.a][d];
      const B = anc[e.b][d];
      if (A === B || A.parent !== B.parent) continue;
      const pid = A.parent?.id ?? -1;
      let s = byParent.get(pid);
      if (!s) {
        s = new Set();
        byParent.set(pid, s);
      }
      s.add(`${Math.min(A.order, B.order)}:${Math.max(A.order, B.order)}`);
    }
    for (const [pid, set] of byParent) {
      const p = pid === -1 ? root : nodes[pid];
      const sib: RLink[] = [];
      for (const k of set) {
        const c = k.indexOf(':');
        sib.push({ a: +k.slice(0, c), b: +k.slice(c + 1), w: 1 });
      }
      p.star = findStar(p.children.length, sib);
    }
  }

  // Reserve each cluster's disc, then position clusters level by level. Working
  // top-down means that when a level is laid out every coarser cluster already
  // has its final position ??exactly what a link leaving the parent needs in
  // order to pull its owner toward the right wall.
  // Size every cluster from the bottom up, the root included, then position them
  // level by level. Working top-down means that when a level is laid out every
  // coarser cluster already has its final position — exactly what a link leaving
  // the parent needs in order to pull its owner toward the right wall.
  sizeTree(root, moats, affinityWeights);


  const extX = new Float64Array(nodes.length);
  const extY = new Float64Array(nodes.length);
  const extW = new Float64Array(nodes.length);
  const ext = { x: extX, y: extY, w: extW };
  for (let d = 0; d < depth; d++) {
    // Two sweeps below the top level. The first can only aim a crossing link at
    // the far *parent* ??the finest thing positioned so far ??while the second
    // re-aims it at the far cluster itself, now that this level has positions.
    // That is what turns "lean toward the platform" into "lean toward the hub of
    // my own region".
    const sweeps = d === 0 ? 1 : 2;
    for (let pass = 0; pass < sweeps; pass++) {
      extX.fill(0);
      extY.fill(0);
      extW.fill(0);
      const byParent = new Map<number, Map<string, RLink>>();
      for (const e of edges) {
        const A = anc[e.a][d];
        const B = anc[e.b][d];
        // Same cluster here ??the edge shapes a deeper level instead.
        if (A !== B) addLevelEdge(A, B, e.w, pass, byParent, ext);
      }
      const parents = d === 0 ? [root] : nodes.filter((n) => n.depth === d - 1);
      for (const p of parents) {
        const m = byParent.get(p.id);
        layoutChildren(p, m ? [...m.values()] : [], extX, extY, extW, affinityWeights);
      }
    }
  }

  // Item-level links: which stay inside a resource group (they arrange it) and
  // which leave it (they tug their owner toward the neighbour's side).
  const intra = new Map<number, RLink[]>();
  const itemExtX = new Float64Array(items.length);
  const itemExtY = new Float64Array(items.length);
  const itemExtW = new Float64Array(items.length);
  for (const e of edges) {
    const A = anc[e.a][depth - 1];
    const B = anc[e.b][depth - 1];
    if (A === B) {
      const arr = intra.get(A.id);
      if (arr) arr.push(e);
      else intra.set(A.id, [e]);
    } else {
      itemExtX[e.a] += B.x * e.w;
      itemExtY[e.a] += B.y * e.w;
      itemExtW[e.a] += e.w;
      itemExtX[e.b] += A.x * e.w;
      itemExtY[e.b] += A.y * e.w;
      itemExtW[e.b] += e.w;
    }
  }

  // Carve the hex grid: grow every cluster at its seed and ring it with the moat
  // for its level, so its wall survives whatever grows next to it.
  const occupied = new Set<string>();
  const blocked = new Set<string>();
  const isFree = (q: number, r: number): boolean => {
    const key = axialKey(q, r);
    return !occupied.has(key) && !blocked.has(key);
  };
  const assign = new Map<string, Axial[]>();
  let maxLeaf = 1;
  for (const n of nodes) if (n.children.length === 0 && n.size > maxLeaf) maxLeaf = n.size;
  const nudge = hexSpiral(Math.max(8, Math.min(64, Math.ceil(2 * tightRadius(maxLeaf)) + 6)));

  /** Arrange a resource group's members over the cells it just claimed. */
  const placeItems = (node: RNode, blob: Axial[]): void => {
    const local = node.items;
    if (local.length === 0 || blob.length === 0) return;
    if (local.length === 1) {
      assign.set(items[local[0]].name, blob.slice());
      return;
    }
    const n = local.length;
    const at = new Map<number, number>();
    local.forEach((gi, li) => at.set(gi, li));
    const rad = new Float64Array(n);
    const central = new Float64Array(n);
    const weight = new Float64Array(n);
    const aff: (string | null)[][] = new Array(n);
    const lx = new Float64Array(n);
    const ly = new Float64Array(n);
    const lw = new Float64Array(n);
    const degree = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const it = items[local[i]];
      const size = Math.max(1, it.size ?? 1);
      // Half the cell pitch, so two linked resources can settle on adjacent cells.
      rad[i] = 0.5 * MOAT_PITCH * Math.sqrt(size);
      central[i] = it.central ?? 0;
      weight[i] = size;
      aff[i] = [];
      const w = itemExtW[local[i]];
      lw[i] = w;
      lx[i] = itemExtX[local[i]] - node.x * w;
      ly[i] = itemExtY[local[i]] - node.y * w;
    }
    const links: RLink[] = [];
    for (const e of intra.get(node.id) ?? []) {
      const a = at.get(e.a);
      const b = at.get(e.b);
      if (a === undefined || b === undefined) continue;
      links.push({ a, b, w: e.w });
      degree[a] += e.w;
      degree[b] += e.w;
    }
    // Relax within the blob's own footprint, then snap onto its cells.
    let cx = 0;
    let cy = 0;
    const cells = blob.map((c) => {
      const [x, y] = axialToPixel(c[0], c[1], 1);
      cx += x;
      cy += y;
      return { c, x, y };
    });
    cx /= cells.length;
    cy /= cells.length;
    let spread = 1;
    for (const p of cells) spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy));
    const { px, py } = relaxSiblings(
      rad, central, weight, links, lx, ly, lw, aff, [], spread, true, 0.16,
    );
    // Hand out cells by walking the wiring outward from each magnet: the
    // best-connected, most-shared resource takes the spot it asked for, then
    // whatever is attached to it takes the free cell nearest *it*, and so on.
    // Snapping each resource independently would leave a VM's NIC and disks a
    // couple of cells adrift; following the links makes them settle against it.
    const taken = new Uint8Array(cells.length);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const l of links) {
      adj[l.a].push(l.b);
      adj[l.b].push(l.a);
    }
    const prio = (i: number): number => degree[i] + central[i] * 2;
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => prio(b) - prio(a) || weight[b] - weight[a] || a - b,
    );
    const placedAt = new Int32Array(n).fill(-1);
    /** Claim the `want` free cells nearest a point, returning their indices. */
    const claim = (tx: number, ty: number, want: number): number[] => {
      const out: number[] = [];
      for (let k = 0; k < want; k++) {
        let best = -1;
        let bestD = Infinity;
        for (let ci = 0; ci < cells.length; ci++) {
          if (taken[ci]) continue;
          const dx = cells[ci].x - tx;
          const dy = cells[ci].y - ty;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = ci;
          }
        }
        if (best < 0) break;
        taken[best] = 1;
        out.push(best);
      }
      return out;
    };
    const queue: number[] = [];
    // `seen` is what terminates the walk: when a blob came up short there are no
    // cells left to claim, and keying off "has a cell" would let two unplaced
    // neighbours push each other forever.
    const seen = new Uint8Array(n);
    for (const seed of order) {
      if (seen[seed] === 1) continue;
      queue.length = 0;
      queue.push(seed);
      seen[seed] = 1;
      while (queue.length > 0) {
        const i = queue.shift() as number;
        // Aim at where the relaxation put it, pulled toward the neighbours that
        // are already down ??that is what makes the filings cling.
        let tx = cx + px[i];
        let ty = cy + py[i];
        let sx = 0;
        let sy = 0;
        let wn = 0;
        for (const j of adj[i]) {
          if (placedAt[j] < 0) continue;
          sx += cells[placedAt[j]].x;
          sy += cells[placedAt[j]].y;
          wn++;
        }
        if (wn > 0) {
          // Once a neighbour is down, cling to it: the relaxation only decides
          // roughly where the molecule sits, adjacency decides the rest.
          tx = 0.2 * tx + (0.8 * sx) / wn;
          ty = 0.2 * ty + (0.8 * sy) / wn;
        }
        const want = Math.max(1, items[local[i]].size ?? 1);
        const idx = claim(tx, ty, want);
        if (idx.length > 0) placedAt[i] = idx[0];
        assign.set(items[local[i]].name, idx.map((ci) => cells[ci].c));
        for (const j of adj[i]) {
          if (seen[j] === 1) continue;
          seen[j] = 1;
          queue.push(j);
        }
      }
    }
  };

  const growLeaf = (node: RNode): Axial[] => {
    const frac = pixelToAxial(node.x, node.y, 1);
    const base = hexRound(frac[0], frac[1]);
    let anchor: Axial = base;
    for (const off of nudge) {
      if (isFree(base[0] + off[0], base[1] + off[1])) {
        anchor = [base[0] + off[0], base[1] + off[1]];
        break;
      }
    }
    const blob = growBlob(anchor, node.size, isFree);
    for (const c of blob) occupied.add(axialKey(c[0], c[1]));
    if (blob.length < node.size) fillShort(blob, node.size, anchor, occupied, blocked);
    placeItems(node, blob);
    return blob;
  };

  const growNode = (node: RNode): Axial[] => {
    let cells: Axial[];
    if (node.children.length === 0) {
      cells = growLeaf(node);
    } else {
      cells = [];
      // Most-shared first — it settles at the centre — then outward from there,
      // so growth always pushes into open ground instead of hunting for a gap
      // behind the frontier it has already laid down.
      const kids = node.children.slice().sort((a, b) => {
        if (b.central !== a.central) return b.central - a.central;
        const da = (a.x - node.x) ** 2 + (a.y - node.y) ** 2;
        const db = (b.x - node.x) ** 2 + (b.y - node.y) ** 2;
        return da - db || b.size - a.size || a.order - b.order;
      });
      for (const k of kids) for (const c of growNode(k)) cells.push(c);
    }
    reserveMoat(cells, moats[node.depth] ?? 0, occupied, blocked);
    return cells;
  };

  const tops = root.children
    .slice()
    .sort((a, b) => b.central - a.central || b.size - a.size || a.order - b.order);
  for (const t of tops) growNode(t);

  return items.map((it) => {
    const cells = assign.get(it.name) ?? [];
    return { name: it.name, size: cells.length, anchor: cells[0] ?? [0, 0], cells };
  });
}
