// Deterministic workload placement on the hex grid.
//
// Each workload's home cell is a pure function of its name (a hash selects a
// spiral index), so a given name always lands in the same neighborhood. If that
// cell is taken, we probe forward along the spiral — deterministic as long as
// workloads are placed in a stable order. Multi-cell workloads then claim a
// contiguous cluster of free cells by breadth-first growth from the anchor.

import {
  hexNeighbors,
  hexSpiral,
  hexRing,
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
  /** Locality key — items sharing a group land in one contiguous blob. */
  group: string;
}

/** FNV-1a hash of a string → uint32. */
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
   * spiral — so consecutive groups end up adjacent and the whole estate fills a
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
   * toward the cell nearest the anchor so the blob grows radially — round and
   * unbiased — rather than drifting in one direction. Deterministic: remaining
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

// ── Hierarchical placement with graduated gaps ───────────────────────────────
//
// Lay workloads out by a group *path* (coarse → fine, e.g. [mgmtGroup,
// subscription, resourceGroup]) so that items grow as tight blobs at the leaf
// and each level of the hierarchy is separated by empty "moat" cells. The gap
// widens the higher up the tree two neighbours diverge — items with low
// locality are pushed visibly apart, while tightly-related items stay fused.

/** One workload to place hierarchically, tagged with its group path. */
export interface HierItem {
  name: string;
  size: number;
  /** Group keys from coarsest (index 0) to finest. */
  path: string[];
  /**
   * Optional "shared-ness" in [0, 1] — how common the resource is to the rest of
   * its cluster (e.g. spoke network or hub connectivity ≈ 1, a single VM ≈ 0).
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

/** Default target aspect ratio (width:height) for the overall footprint — a 16:9 monitor. */
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

/** Translate a cluster so the mean of its cells sits at (0,0) — keeps packs compact. */
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
 * (O(1) per test) even when packing thousands of clusters — the key to scaling
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

  // Coarse grid of placed circles: bin key "bx,by" → circles, for O(1) collision.
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

// ── Dense "territory map" placement ──────────────────────────────────────────
//
// Circle-packing (placeHierarchical) arranges each group as a bounding circle,
// which inherently leaves black interstitial gaps between clusters. `placeDense`
// instead grows the WHOLE estate as one gap-free honeycomb and recursively
// carves it into contiguous group territories (like a country map), so the only
// empty space is outside the outline. The `aspect` preference shapes just that
// outline (wider ⇒ fills a 16:9 screen when fit) — it never scatters clusters.

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
 * the region so far (fills concavities → the blob stays compact and hugs the
 * cells already carved, so sibling territories tessellate with no holes). Ties
 * break toward the cell nearest the blob's *running centroid* (not the fixed
 * anchor, which goes stale as the blob fills asymmetrically) — this keeps growth
 * radially balanced so the territory stays round instead of drifting into a long
 * finger — then a stable key. O(size) via adjacency buckets (a frontier cell
 * lives in the bucket for its chosen-edge count).
 */
function growBlob(
  anchor: Axial,
  size: number,
  isFree: (q: number, r: number) => boolean,
): Axial[] {
  const chosen: Axial[] = [];
  const chosenKeys = new Set<string>();
  const buckets: Map<string, Axial>[] = [];
  for (let i = 0; i < 7; i++) buckets.push(new Map());
  const adjOf = new Map<string, number>();
  // Running sum of chosen axial coords → centroid, so ties break toward the
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
        // Squared hex-axial distance to the centroid (∝ pixel distance²).
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
 *  the next territory can't grow into it — a consistent gap between groups. */
function reserveMoat(
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
 * where the estate diverges (the selected locality — e.g. hubs for a hub
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

  // First path level whose key varies across the estate → the territory level.
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
    // Hand out consecutive cells to each member (path order → sub-neighbourhoods).
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

// ── Affinity (force-directed) placement ──────────────────────────────────────
//
// A different philosophy from placeDense: rather than packing every cell into a
// rigid centre-out honeycomb (whose outline is inevitably a big hexagon), we let
// territories find their own positions by *affinity*. Each territory is a node in
// a force simulation: it is attracted toward the centroid of every other
// territory that shares an attribute (same workload, same hub, same environment,
// …) and repelled by all its neighbours so footprints don't overlap. Relaxing
// this system yields an organic, map-like arrangement — regional continents of
// same-hub territories, with same-workload prod/dev islands sitting together —
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
  /** Attraction weight per attribute position of `path` (leaf excluded); missing → 1. */
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

/** Order members most "shared" first (higher `central`), then by leaf key — so
 *  common infrastructure is handed the innermost cells of its cluster. */
function cmpCentral(a: HierItem, b: HierItem): number {
  const ca = a.central ?? 0;
  const cb = b.central ?? 0;
  if (ca !== cb) return cb - ca;
  return cmpLeaf(a, b);
}

/**
 * A territory's "shared-ness" — how central it should sit in its region. A
 * cluster that *contains* shared/hub infrastructure (a Virtual WAN hub, Azure
 * Firewall, ExpressRoute or VNet gateway, DNS Private Resolver, …) is itself a
 * shared hub, even when that infra is only a small fraction of its cells. So we
 * take the max of the size-weighted mean and a discounted *peak* member central:
 * the mean still ranks ordinary clusters by their average, while any cluster
 * holding a high-central resource is lifted near the top and pulled to the
 * centre of its hub — instead of being diluted by many workload-specific leaves.
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

/** Apply mutual repulsion between nodes i and j (only once, when j > i). */
function repelPair(
  i: number,
  j: number,
  px: Float64Array,
  py: Float64Array,
  rad: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  strength: number,
): void {
  if (j <= i) return;
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
): void {
  const n = px.length;
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
      for (const j of bucket) repelPair(i, j, px, py, rad, fx, fy, strength);
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
 *  so the relaxation can't collapse them into a dense core — the intra-hub gaps
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
  // Space the primary clusters by cumulative SIZE, largest first — not by
  // index. Real estates have wildly uneven top-level groups, and index spacing
  // hands a two-resource cluster the same inner ring as a ten-thousand-cell
  // one, which evacuates the middle and leaves the whole estate a hollow ring.
  const csizeOf = new Map<string, number>();
  let totalSize = 0;
  for (const [v, members] of primary) {
    let s = 0;
    for (const i of members) s += groups[i].size;
    csizeOf.set(v, s);
    totalSize += s;
  }
  const pv = [...primary.keys()].sort(
    (a, b) => (csizeOf.get(b) ?? 0) - (csizeOf.get(a) ?? 0) || (a < b ? -1 : 1),
  );
  let cum = 0;
  pv.forEach((v, pi) => {
    const members = (primary.get(v) ?? []).slice().sort(order);
    const csize = csizeOf.get(v) ?? 1;
    const cr = r0 * fill * 0.68 * Math.sqrt((cum + csize / 2) / Math.max(1, totalSize));
    cum += csize;
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

  // Attribute value → member indices, one map per attribute position.
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

  // Hierarchical seeding + anchoring: the coarsest attribute (position 0 — e.g.
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

/** Top up a stalled `blob` to `size` without ever eating a moat (`blocked`), so
 *  the inter-workload gap always survives. Rather than smearing the overflow
 *  along a ring (which reads as a thin tail), it grows the missing cells as a
 *  compact clump at the nearest free spot: the blob may fragment, but each piece
 *  keeps a natural rounded shape — no contortion is done to avoid fragmenting. */
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
  let guard = 0;
  while (blob.length < size && guard++ < 4096) {
    let spot: Axial | null = null;
    for (let radius = 1; radius < 512 && !spot; radius++) {
      for (const c of hexRing(radius)) {
        if (free(anchor[0] + c[0], anchor[1] + c[1])) {
          spot = [anchor[0] + c[0], anchor[1] + c[1]];
          break;
        }
      }
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
 * Affinity placement — see the section comment above. `path` is read as an
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
  const scale = (r0 * fill * 1.95) / maxr; // seed units → pixels; >1 leaves room for the veins
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
    // its full size here it simply fragments — `fillShort` reclaims only the soft
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
  // medium between workloads, thin between subscriptions — with the hex cells as
  // the smallest tissue filling each subscription areole. Growth is nested
  // (hub › workload › subscription) so each level's region is one contiguous
  // areole ringed by a vein of its level's width.
  const W_SUB = 1;
  const W_WL = 2;
  const W_HUB = 4;
  const sizeOf = (idxs: number[]): number => idxs.reduce((s, i) => s + groups[i].size, 0);

  // Grow a set of subscriptions (largest first), each ringed by a thin vein;
  // returns their combined cells so a parent vein can ring the whole group.
  const growSubs = (subIdxs: number[]): Axial[] => {
    const cells: Axial[] = [];
    // Most-shared first (connectivity → centre), then largest-first into open space.
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

  // Build the hub › workload hierarchy from the attribute vector.
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
