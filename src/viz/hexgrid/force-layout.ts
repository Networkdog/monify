// Force-directed hierarchical placement — where a resource sits is an argument
// between the things Azure says about it.
//
// The wall is only useful if position carries meaning: an operator should be
// able to glance at a red patch and know *what* is broken before reading a
// single label. That needs the map to be laid out by the estate's own structure,
// with each relationship pulling exactly as hard as it matters:
//
//   · a resource group is the strongest tie there is — the resources in one are
//     deployed, versioned and deleted together, so they form a single contiguous
//     clump with no gap inside it at all;
//   · a subscription is one step weaker — its resource groups relax as separate
//     bodies inside a shared disc, close but individually readable;
//   · a management group is another step weaker again — its subscriptions
//     gather, but loosely enough that each one keeps its own outline.
//
// Those three cohesions set the skeleton. Competing against them, and against
// each other, are the forces that carry Azure's actual topology:
//
//   · dependency links — a NIC pulls on its machine, a private endpoint on the
//     database it fronts, an app on its vault. Inside a cluster this is what
//     decides the arrangement; across a wall it becomes a pull toward the far
//     cluster, so a subscription drifts to the side of its parent that faces
//     whatever it depends on;
//   · the Virtual WAN hub — every subscription peered to the same hub is drawn
//     toward the others on it, so a hub's spokes settle into one region of the
//     management group rather than scattering through it;
//   · shared-ness — the more of the estate points at a resource, the closer to
//     the middle of its cluster it sits, so the spine of a subscription (its
//     network, its vault, its workspace) reads as its core.
//
// The result is not a packing but a settlement: nothing is placed on a grid of
// its own, and no cluster is forced into a shape. Cells are only claimed at the
// very end, once every body has stopped moving.
//
// Two things keep that honest at estate scale. Forces are applied as a weighted
// average of the places they point at, never as a sum, so a resource wired to
// three hundred others settles between them instead of being flung off the map.
// And because discs nested three deep waste most of their area on the gaps
// between circles, the settled arrangement is treated as an arrangement rather
// than a size: it is squeezed until the cells actually claimed fill the map,
// correcting from what the previous attempt measured. The order clusters sit in
// survives that; only the air between them goes.
//
// Deterministic: no randomness anywhere. The same estate always settles the
// same way, which is what lets an operator learn the map.

import {
  hexNeighbors,
  hexSpiral,
  axialToPixel,
  pixelToAxial,
  hexRound,
  axialKey,
  type Axial,
} from './hex';
import { growBlob, reserveMoat, type PlacedWorkload } from './placement';

/** One resource to place. */
export interface ForceItem {
  name: string;
  /** Cells it occupies. Default 1. */
  size?: number;
  /** Containment path, coarsest first — e.g. [managementGroup, subscription, resourceGroup]. */
  path: string[];
  /** Names of the resources it is wired to. Unknown names are ignored. */
  deps?: string[];
  /** 0..1 shared-ness: how much of the estate points at it. Pulls to the middle. */
  central?: number;
  /** A key shared with other clusters that should gather — the Virtual WAN hub. */
  anchor?: string;
}

export interface ForceOptions {
  /**
   * Cohesion per containment depth, coarsest first: how hard a level holds its
   * children together. Defaults to each level pulling twice as hard as the one
   * above it, which is the ordering the map is read by.
   */
  cohesion?: number[];
  /** Pull between clusters that depend on each other. */
  linkK?: number;
  /** Pull between clusters sharing an `anchor` (the same hub). */
  anchorK?: number;
  /** How much wider the moat is between two clusters with nothing in common —
   *  no link, no hub. 1 spaces everything alike. */
  strangerGap?: number;
  /** Empty cells ringing a cluster at each depth, coarsest first. */
  moats?: number[];
  /** Relaxation sweeps per parent. */
  iterations?: number;
}

/** Distance between adjacent hex centres, in the pixel units axialToPixel uses. */
const PITCH = Math.sqrt(3);
/** Radius of the disc with one hex cell's area — sqrt((3√3/2)/π). */
const CELL_R = Math.sqrt((3 * Math.sqrt(3)) / 2 / Math.PI);
/** Golden angle — the sunflower seeding every relaxation starts from. */
const GA = Math.PI * (3 - Math.sqrt(5));
/** Slack on every cluster radius, so moats and settling have somewhere to go. */
const SLACK = 1.06;
/** What a relaxed, squeezed pack of unequal discs actually fills. */
const PACK = 0.74;
const DEFAULT_ITERATIONS = 90;
/** How far a cluster moves toward what the forces agreed on, each sweep. */
const DAMP = 0.35;
/** Squeeze rounds after relaxation: shrink toward the middle, push apart, repeat. */
const SQUEEZE_ROUNDS = 32;
const SQUEEZE_STEP = 0.93;
/** Area of one hex cell at R = 1, the unit `axialToPixel` works in. */
const HEX_AREA = (3 * Math.sqrt(3)) / 2;
/** Share of the map's bounding box the claimed cells should cover. Moats and a
 *  round outline account for the rest; asking for much more only pushes clusters
 *  away from where they settled. */
const TARGET_FILL = 0.5;

interface FNode {
  key: string;
  depth: number;
  children: FNode[];
  /** Item indices, on the deepest containment nodes only. */
  items: number[];
  count: number;
  r: number;
  x: number;
  y: number;
  /** Hub shared by the resources beneath, when they agree on one. */
  anchor: string;
  /** Attraction to sibling branches, keyed by sibling index. Filled per parent. */
  pull: Map<number, number>;
}

function newNode(key: string, depth: number): FNode {
  return { key, depth, children: [], items: [], count: 0, r: 0, x: 0, y: 0, anchor: '', pull: new Map() };
}

/**
 * Build the containment tree, remembering for every resource the chain of nodes
 * it belongs to — the chain is what tells a link which level it crosses.
 */
function buildTree(items: ForceItem[]): { root: FNode; chain: FNode[][] } {
  const root = newNode('', 0);
  const chain: FNode[][] = new Array(items.length);
  const index = new Map<string, FNode>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let node = root;
    const own: FNode[] = [root];
    let key = '';
    for (let d = 0; d < it.path.length; d++) {
      key += `\u0001${it.path[d]}`;
      let child = index.get(key);
      if (!child) {
        child = newNode(key, d + 1);
        index.set(key, child);
        node.children.push(child);
      }
      node = child;
      own.push(child);
    }
    node.items.push(i);
    chain[i] = own;
    const size = Math.max(1, it.size ?? 1);
    for (const n of own) n.count += size;
  }
  return { root, chain };
}

/** Radius a node needs, bottom-up: leaves from their cell count, parents from
 *  the discs they have to hold. */
function sizeTree(node: FNode, moats: number[]): void {
  if (node.children.length === 0) {
    node.r = Math.sqrt(node.count) * CELL_R * SLACK;
    return;
  }
  for (const c of node.children) sizeTree(c, moats);
  estimate(node, moats);
}

/** How big a node must be to hold the children it has now. Only an estimate —
 *  the seed for its relaxation; `settle` replaces it with what was measured. */
function estimate(node: FNode, moats: number[]): void {
  const moat = (moats[node.depth] ?? 1) * PITCH;
  let area = 0;
  for (const c of node.children) {
    const e = c.r + moat * 0.5;
    area += e * e;
  }
  node.r = Math.max(Math.sqrt(area / PACK), PITCH) * SLACK;
}

/** The hub a node's resources agree on, if they agree at all. */
function markAnchors(node: FNode, items: ForceItem[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const i of node.items) {
    const a = items[i].anchor;
    if (a) tally.set(a, (tally.get(a) ?? 0) + 1);
  }
  for (const c of node.children) {
    for (const [k, v] of markAnchors(c, items)) tally.set(k, (tally.get(k) ?? 0) + v);
  }
  let best = '';
  let bestN = 0;
  for (const [k, v] of tally) {
    if (v > bestN || (v === bestN && k < best)) {
      best = k;
      bestN = v;
    }
  }
  node.anchor = best;
  return tally;
}

/**
 * Turn every dependency into a pull at the level it actually crosses. A link
 * inside one resource group says nothing about where clusters go; a link between
 * two subscriptions is the reason one sits next to the other.
 */
function wireLevels(items: ForceItem[], chain: FNode[][], byName: Map<string, number>): void {
  for (let a = 0; a < items.length; a++) {
    for (const dep of items[a].deps ?? []) {
      const b = byName.get(dep);
      if (b === undefined || b === a) continue;
      const ca = chain[a];
      const cb = chain[b];
      const n = Math.min(ca.length, cb.length);
      let d = 0;
      while (d < n && ca[d] === cb[d]) d++;
      // ca[d-1] is the lowest common ancestor; its two children carry the pull.
      if (d === 0 || d >= n) continue;
      const pa = ca[d];
      const pb = cb[d];
      if (pa === pb) continue;
      pa.pull.set(pb.depth * 1e9 + hashNode(pb), (pa.pull.get(pb.depth * 1e9 + hashNode(pb)) ?? 0) + 1);
      pb.pull.set(pa.depth * 1e9 + hashNode(pa), (pb.pull.get(pa.depth * 1e9 + hashNode(pa)) ?? 0) + 1);
    }
  }
}

/** Stable numeric id per node, assigned on first sight. */
const NODE_ID = new WeakMap<FNode, number>();
let nextNodeId = 1;
function hashNode(n: FNode): number {
  let id = NODE_ID.get(n);
  if (id === undefined) {
    id = nextNodeId++;
    NODE_ID.set(n, id);
  }
  return id;
}

/**
 * Two passes of pairwise push-apart: sibling discs may touch, never overlap.
 *
 * This is also where the map says who belongs next to whom. Every force in the
 * relaxation is eventually undone by the squeeze — that is the squeeze's job —
 * but the squeeze works *through* this constraint, calling it after every
 * shrink. So the one spacing that survives to the finished map is the one asked
 * for here, which is why relatedness is spent on the moat rather than on a
 * force: clusters with a link or a hub in common are allowed to touch across a
 * normal moat, strangers are held at a wider one.
 */
function separate(
  px: Float64Array,
  py: Float64Array,
  kids: FNode[],
  moat: number,
  kin: Uint8Array,
  strangerGap: number,
): void {
  const n = kids.length;
  const far = moat * strangerGap;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const row = i * n;
      const ri = kids[i].r;
      for (let j = i + 1; j < n; j++) {
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const want = ri + kids[j].r + (kin[row + j] === 1 ? moat : far);
        const d = Math.hypot(dx, dy);
        if (d >= want) continue;
        if (d < 1e-9) {
          px[j] += want * 0.5;
          continue;
        }
        const push = (want - d) * 0.5;
        const ux = (dx / d) * push;
        const uy = (dy / d) * push;
        px[i] -= ux;
        py[i] -= uy;
        px[j] += ux;
        py[j] += uy;
      }
    }
  }
}

/**
 * Settle a node's children inside it, in coordinates relative to the node.
 * Cohesion holds them to the middle at the stiffness this depth is worth, links
 * and shared hubs pull them at each other, nothing is allowed to overlap, and
 * the whole pack is then squeezed until the discs are actually touching. The
 * node's radius ends up being what was measured, not what was guessed.
 */
function relax(parent: FNode, opts: Required<ForceOptions>): void {
  const kids = parent.children;
  const n = kids.length;
  if (n === 0) return;
  const moat = (opts.moats[parent.depth] ?? 1) * PITCH;
  if (n === 1) {
    kids[0].x = 0;
    kids[0].y = 0;
    parent.r = Math.max(kids[0].r, PITCH);
    return;
  }
  const k = opts.cohesion[parent.depth] ?? opts.cohesion[opts.cohesion.length - 1];
  // Biggest first on a sunflower: the heavy clusters take the middle, which is
  // both the stable arrangement and the readable one.
  const order = kids
    .map((_, i) => i)
    .sort((a, b) => kids[b].count - kids[a].count || (kids[a].key < kids[b].key ? -1 : 1));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const idOf = new Map<number, number>();
  const keyAt = new Float64Array(n);
  order.forEach((i, rank) => {
    const rr = parent.r * 0.72 * Math.sqrt((rank + 0.5) / n);
    px[i] = Math.cos(rank * GA) * rr;
    py[i] = Math.sin(rank * GA) * rr;
    keyAt[i] = kids[i].depth * 1e9 + hashNode(kids[i]);
    idOf.set(keyAt[i], i);
  });

  // Who has business being neighbours. Every separation pass consults it, and
  // there are hundreds of those, so it is worth building once.
  const kin = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    const a = kids[i].anchor;
    for (let j = i + 1; j < n; j++) {
      if (!kids[i].pull.has(keyAt[j]) && (a === '' || a !== kids[j].anchor)) continue;
      kin[i * n + j] = 1;
      kin[j * n + i] = 1;
    }
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fw = new Float64Array(n);
  const anchorAt = new Map<string, [number, number, number]>();
  for (let iter = 0; iter < opts.iterations; iter++) {
    // Each force names a place the cluster would rather be, and how much it
    // means it. The cluster then moves part of the way to the weighted average
    // of those places — never further than the furthest of them, which is what
    // keeps a resource wired to three hundred others from flinging itself off
    // the map. Summing raw forces here does exactly that.
    fx.fill(0);
    fy.fill(0);
    // Cohesion wants the middle, at this level's grip.
    fw.fill(k);
    // Shared hubs: everything peered to one hub wants that crowd's centre.
    anchorAt.clear();
    for (let i = 0; i < n; i++) {
      const a = kids[i].anchor;
      if (!a) continue;
      const acc = anchorAt.get(a);
      if (acc) {
        acc[0] += px[i];
        acc[1] += py[i];
        acc[2]++;
      } else anchorAt.set(a, [px[i], py[i], 1]);
    }
    for (let i = 0; i < n; i++) {
      // Dependencies: the mean of what this cluster is wired to, weighted by
      // how much traffic each link represents.
      let lx = 0;
      let ly = 0;
      let lw = 0;
      for (const [key, w] of kids[i].pull) {
        const j = idOf.get(key);
        if (j === undefined || j === i) continue;
        const s = Math.log1p(w);
        lx += px[j] * s;
        ly += py[j] * s;
        lw += s;
      }
      if (lw > 0) {
        fx[i] += (lx / lw) * opts.linkK;
        fy[i] += (ly / lw) * opts.linkK;
        fw[i] += opts.linkK;
      }
      const acc = kids[i].anchor ? anchorAt.get(kids[i].anchor) : undefined;
      if (acc && acc[2] > 1) {
        fx[i] += ((acc[0] - px[i]) / (acc[2] - 1)) * opts.anchorK;
        fy[i] += ((acc[1] - py[i]) / (acc[2] - 1)) * opts.anchorK;
        fw[i] += opts.anchorK;
      }
    }
    for (let i = 0; i < n; i++) {
      if (fw[i] <= 0) continue;
      px[i] += (fx[i] / fw[i] - px[i]) * DAMP;
      py[i] += (fy[i] / fw[i] - py[i]) * DAMP;
    }
    // Separation: discs may touch, never overlap — and strangers stay further
    // apart than that.
    separate(px, py, kids, moat, kin, opts.strangerGap);
  }
  // The estimate always over-reserves, and empty space is the one thing a map
  // like this cannot spend: pull everything back toward the middle and push it
  // apart again, until the arrangement the forces chose is as tight as it goes.
  // The push back is what carries the relatedness spacing into the final map.
  for (let round = 0; round < SQUEEZE_ROUNDS; round++) {
    for (let i = 0; i < n; i++) {
      px[i] *= SQUEEZE_STEP;
      py[i] *= SQUEEZE_STEP;
    }
    separate(px, py, kids, moat, kin, opts.strangerGap);
    separate(px, py, kids, moat, kin, opts.strangerGap);
  }
  // Re-centre, then take the node's radius from the measurement.
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += px[i];
    cy += py[i];
  }
  cx /= n;
  cy /= n;
  let need = 0;
  for (let i = 0; i < n; i++) {
    px[i] -= cx;
    py[i] -= cy;
    need = Math.max(need, Math.hypot(px[i], py[i]) + kids[i].r);
  }
  parent.r = Math.max(need + moat * 0.5, PITCH);
  for (let i = 0; i < n; i++) {
    kids[i].x = px[i];
    kids[i].y = py[i];
  }
}

/** Settle the whole tree from the leaves up, so every level packs against the
 *  room its children really needed rather than the room they were promised. */
function settle(node: FNode, opts: Required<ForceOptions>): void {
  for (const c of node.children) settle(c, opts);
  if (node.children.length === 0) return;
  estimate(node, opts.moats);
  relax(node, opts);
}

/** Turn the relative positions `settle` produced into absolute ones. */
function translate(node: FNode): void {
  for (const c of node.children) {
    c.x += node.x;
    c.y += node.y;
    translate(c);
  }
}

/**
 * The order a cluster's resources are handed cells in: start at whatever the
 * rest of the estate leans on most, then walk its wiring outward. Cells come out
 * of the blob middle-first, so this puts the shared spine in the core and keeps
 * each little molecule — a machine with its interface and disks — together
 * instead of smeared into a ring of its own kind.
 */
function walkOrder(idx: number[], items: ForceItem[], byName: Map<string, number>): number[] {
  const inCluster = new Set(idx);
  const rank = new Map<number, number>();
  idx.forEach((i, n) => rank.set(i, n));
  const seeds = idx
    .slice()
    .sort(
      (a, b) =>
        (items[b].central ?? 0) - (items[a].central ?? 0) ||
        (items[a].name < items[b].name ? -1 : 1),
    );
  const out: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const seed of seeds) {
    if (seen.has(seed)) continue;
    stack.push(seed);
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const next: number[] = [];
      for (const dep of items[cur].deps ?? []) {
        const j = byName.get(dep);
        if (j !== undefined && inCluster.has(j) && !seen.has(j)) next.push(j);
      }
      // Least shared first onto the stack, so the most shared comes off first.
      next.sort(
        (a, b) =>
          (items[a].central ?? 0) - (items[b].central ?? 0) ||
          (items[b].name < items[a].name ? -1 : 1),
      );
      for (const j of next) stack.push(j);
    }
  }
  // Anything the walk never reached keeps its input order.
  for (const i of idx) if (!seen.has(i)) out.push(i);
  return out;
}

/** Every deepest containment node, middle of the map first. */
function leaves(root: FNode): FNode[] {
  const out: FNode[] = [];
  const walk = (n: FNode): void => {
    if (n.children.length === 0) out.push(n);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  out.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || (a.key < b.key ? -1 : 1));
  return out;
}

/**
 * Hand out real cells for one settled arrangement, at the given scale. Clusters
 * are taken middle-out so the crowded core is served first, each growing a
 * contiguous clump at the spot it settled on and reserving a moat behind it.
 * Returns how densely the result came out, which is what drives the next pass.
 */
function claim(
  order: FNode[],
  items: ForceItem[],
  byName: Map<string, number>,
  settings: Required<ForceOptions>,
  scale: number,
): { out: PlacedWorkload[]; fill: number } {
  const out: PlacedWorkload[] = items.map((it) => ({
    name: it.name,
    size: 0,
    anchor: [0, 0] as Axial,
    cells: [],
  }));
  const occupied = new Set<string>();
  const blocked = new Set<string>();
  const spiral = hexSpiral(220);
  const free = (q: number, r: number): boolean => {
    const k = axialKey(q, r);
    return !occupied.has(k) && !blocked.has(k);
  };
  const vacant = (q: number, r: number): boolean => !occupied.has(axialKey(q, r));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cells = 0;
  for (const leaf of order) {
    if (leaf.items.length === 0) continue;
    const [fq, fr] = pixelToAxial(leaf.x * scale, leaf.y * scale, 1);
    const want = hexRound(fq, fr);
    let anchor: Axial | null = null;
    for (const off of spiral) {
      const q = want[0] + off[0];
      const r = want[1] + off[1];
      if (free(q, r)) {
        anchor = [q, r];
        break;
      }
    }
    if (!anchor) continue;
    // A moat is a courtesy, not a wall: if honouring one would leave a cluster
    // short of cells, the cluster wins and the moat is spent.
    let blob = growBlob(anchor, leaf.count, free);
    if (blob.length < leaf.count) blob = growBlob(anchor, leaf.count, vacant);
    for (const c of blob) {
      occupied.add(axialKey(c[0], c[1]));
      const [bx, by] = axialToPixel(c[0], c[1], 1);
      if (bx < minX) minX = bx;
      if (bx > maxX) maxX = bx;
      if (by < minY) minY = by;
      if (by > maxY) maxY = by;
      cells++;
    }
    let cursor = 0;
    for (const i of walkOrder(leaf.items, items, byName)) {
      const size = Math.max(1, items[i].size ?? 1);
      const cut = blob.slice(cursor, cursor + size);
      cursor += cut.length;
      out[i] = {
        name: items[i].name,
        size: cut.length,
        anchor: cut[0] ?? anchor,
        cells: cut,
      };
    }
    reserveMoat(blob, settings.moats[leaf.depth - 1] ?? 1, occupied, blocked);
  }
  const box = Math.max((maxX - minX) * (maxY - minY), 1e-6);
  return { out, fill: (cells * HEX_AREA) / box };
}

/**
 * Hierarchical force placement — see the comment at the top of this file.
 * Returns placements in input order; deterministic for a given estate.
 */
export function placeForce(items: ForceItem[], opts: ForceOptions = {}): PlacedWorkload[] {
  if (items.length === 0) return [];

  const depth = items.reduce((m, it) => Math.max(m, it.path.length), 0);
  const cohesion = opts.cohesion ?? Array.from({ length: depth + 1 }, (_, d) => 0.02 * 2 ** d);
  const settings: Required<ForceOptions> = {
    cohesion,
    linkK: opts.linkK ?? 0.03,
    anchorK: opts.anchorK ?? 0.012,
    strangerGap: opts.strangerGap ?? 2.5,
    moats: opts.moats ?? Array.from({ length: depth }, (_, d) => Math.max(1, 4 - d)),
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
  };

  const byName = new Map<string, number>();
  items.forEach((it, i) => byName.set(it.name, i));

  const { root, chain } = buildTree(items);
  sizeTree(root, settings.moats);
  markAnchors(root, items);
  wireLevels(items, chain, byName);
  root.x = 0;
  root.y = 0;
  settle(root, settings);
  translate(root);

  // Discs nested three deep waste most of their room on the gaps between
  // circles — room a map cannot afford, because every empty cell is a cell the
  // overview spends on nothing. So the settled arrangement is treated as an
  // arrangement, not as a size: squeeze it until the cells actually claimed fill
  // the map, correcting from what the last pass measured. The order clusters sit
  // in survives; only the air between them goes.
  const order = leaves(root);
  let scale = 1;
  let best = claim(order, items, byName, settings, scale);
  for (let pass = 0; pass < 4 && best.fill < TARGET_FILL * 0.97; pass++) {
    scale *= Math.max(0.25, Math.sqrt(best.fill / TARGET_FILL));
    const next = claim(order, items, byName, settings, scale);
    if (next.fill <= best.fill) break;
    best = next;
  }
  return best.out;
}

/** Neighbour lookup re-exported for tests that check cluster contiguity. */
export { hexNeighbors, axialToPixel };
