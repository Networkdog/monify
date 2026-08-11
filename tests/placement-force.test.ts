import { describe, it, expect } from 'vitest';
import { placeForce, type ForceItem } from '../src/viz/hexgrid/force-layout';
import { hexNeighbors, axialKey, axialToPixel, hexDistance } from '../src/viz/hexgrid/hex';
import type { PlacedWorkload } from '../src/viz/hexgrid/placement';

// A synthetic estate with the shape the force placer is meant to read: three
// management groups, each holding subscriptions, each holding resource groups.
// Half the subscriptions peer with hub A and half with hub B — the hub is not a
// containment wall here, it is a pull, so the test asks whether that pull
// actually moved anything.
const MGS = 3;
const SUBS_PER_MG = 4;
const RGS_PER_SUB = 3;
const RES_PER_RG = 5;
const OPTS = { cohesion: [0.012, 0.03, 0.075, 0.16], moats: [4, 2, 1] };

interface Estate {
  items: ForceItem[];
  /** Resource names grouped by resource group key. */
  byRg: Map<string, string[]>;
  /** Resource names grouped by subscription key. */
  bySub: Map<string, string[]>;
  /** Subscription key → the hub it peers with. */
  hubOfSub: Map<string, string>;
}

function push(into: Map<string, string[]>, key: string, name: string): void {
  const list = into.get(key);
  if (list) list.push(name);
  else into.set(key, [name]);
}

function buildEstate(): Estate {
  const items: ForceItem[] = [];
  const byRg = new Map<string, string[]>();
  const bySub = new Map<string, string[]>();
  const hubOfSub = new Map<string, string>();
  let seq = 0;
  for (let m = 0; m < MGS; m++) {
    const mg = `mg-${m}`;
    for (let s = 0; s < SUBS_PER_MG; s++) {
      const sub = `${mg}/sub-${s}`;
      // Alternate hubs across subscriptions so hub membership cuts across the
      // management-group tree instead of agreeing with it.
      const hub = s % 2 === 0 ? 'hub-a' : 'hub-b';
      hubOfSub.set(sub, hub);
      for (let g = 0; g < RGS_PER_SUB; g++) {
        const rg = `${sub}/rg-${g}`;
        let prev = '';
        for (let i = 0; i < RES_PER_RG; i++) {
          const name = `res-${seq++}`;
          // A chain inside the group, so every group has a link graph to walk.
          items.push({
            name,
            size: 1,
            path: [mg, sub, rg],
            deps: prev ? [prev] : [],
            central: i === 0 ? 0.8 : 0.1,
            anchor: hub,
          });
          push(byRg, rg, name);
          push(bySub, sub, name);
          prev = name;
        }
      }
    }
  }
  return { items, byRg, bySub, hubOfSub };
}

const estate = buildEstate();
const placed = placeForce(estate.items, OPTS);
const at = new Map(placed.map((p) => [p.name, p]));

function cellsOf(name: string): PlacedWorkload['cells'] {
  return at.get(name)?.cells ?? [];
}

/** Centre of mass of a set of resources, in pixel space. */
function centroid(names: string[]): [number, number] {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const name of names) {
    for (const [q, r] of cellsOf(name)) {
      const [px, py] = axialToPixel(q, r, 1);
      x += px;
      y += py;
      n++;
    }
  }
  return n === 0 ? [0, 0] : [x / n, y / n];
}

/** Distance from the centre of mass out to the outermost member. */
function spread(names: string[]): number {
  const [cx, cy] = centroid(names);
  let far = 0;
  for (const name of names) {
    for (const [q, r] of cellsOf(name)) {
      const [px, py] = axialToPixel(q, r, 1);
      far = Math.max(far, Math.hypot(px - cx, py - cy));
    }
  }
  return far;
}

describe('placeForce', () => {
  it('places every resource exactly once, in input order', () => {
    expect(placed).toHaveLength(estate.items.length);
    expect(placed.map((p) => p.name)).toEqual(estate.items.map((it) => it.name));
    for (const p of placed) expect(p.cells.length).toBeGreaterThan(0);
  });

  it('never puts two resources on the same cell', () => {
    const seen = new Set<string>();
    for (const p of placed) {
      for (const [q, r] of p.cells) {
        const k = axialKey(q, r);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('keeps each resource group contiguous', () => {
    for (const [, names] of estate.byRg) {
      const cells = new Set<string>();
      for (const name of names) {
        for (const [q, r] of cellsOf(name)) cells.add(axialKey(q, r));
      }
      // Flood fill from any one cell must reach them all.
      const start = cellsOf(names[0])[0];
      expect(start).toBeDefined();
      const seen = new Set<string>([axialKey(start[0], start[1])]);
      const queue: [number, number][] = [start];
      while (queue.length > 0) {
        const cell = queue.pop();
        if (!cell) break;
        for (const [nq, nr] of hexNeighbors(cell[0], cell[1])) {
          const k = axialKey(nq, nr);
          if (!cells.has(k) || seen.has(k)) continue;
          seen.add(k);
          queue.push([nq, nr]);
        }
      }
      expect(seen.size).toBe(cells.size);
    }
  });

  it('holds a resource group tighter than its subscription', () => {
    for (const [sub, subNames] of estate.bySub) {
      const rgSpreads: number[] = [];
      for (const [rg, rgNames] of estate.byRg) {
        if (rg.startsWith(`${sub}/`)) rgSpreads.push(spread(rgNames));
      }
      expect(Math.max(...rgSpreads)).toBeLessThan(spread(subNames));
    }
  });

  it('holds a subscription tighter than its management group', () => {
    for (let m = 0; m < MGS; m++) {
      const mg = `mg-${m}`;
      const mgNames: string[] = [];
      const subSpreads: number[] = [];
      for (const [sub, names] of estate.bySub) {
        if (!sub.startsWith(`${mg}/`)) continue;
        mgNames.push(...names);
        subSpreads.push(spread(names));
      }
      expect(Math.max(...subSpreads)).toBeLessThan(spread(mgNames));
    }
  });

  it('draws subscriptions that share a hub closer than ones that do not', () => {
    const subs = [...estate.bySub.keys()];
    const centre = new Map(subs.map((s) => [s, centroid(estate.bySub.get(s) ?? [])]));
    let same = 0;
    let sameN = 0;
    let cross = 0;
    let crossN = 0;
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        // Only compare subscriptions in different management groups, so the
        // containment tree cannot be what is doing the work.
        if (subs[i].split('/')[0] === subs[j].split('/')[0]) continue;
        const a = centre.get(subs[i]) ?? [0, 0];
        const b = centre.get(subs[j]) ?? [0, 0];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (estate.hubOfSub.get(subs[i]) === estate.hubOfSub.get(subs[j])) {
          same += d;
          sameN++;
        } else {
          cross += d;
          crossN++;
        }
      }
    }
    expect(sameN).toBeGreaterThan(0);
    expect(crossN).toBeGreaterThan(0);
    expect(same / sameN).toBeLessThan(cross / crossN);
  });

  it('seats linked resources next to each other more often than not', () => {
    let adjacent = 0;
    let total = 0;
    for (const it of estate.items) {
      for (const dep of it.deps ?? []) {
        const a = cellsOf(it.name)[0];
        const b = cellsOf(dep)[0];
        if (!a || !b) continue;
        total++;
        if (hexDistance(a[0], a[1], b[0], b[1]) <= 2) adjacent++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(adjacent / total).toBeGreaterThan(0.5);
  });

  it('is deterministic', () => {
    const again = placeForce(estate.items, OPTS);
    expect(again.map((p) => p.cells)).toEqual(placed.map((p) => p.cells));
  });
});
