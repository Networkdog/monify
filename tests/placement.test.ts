import { describe, it, expect } from 'vitest';
import { HexPlacer, placeHierarchical, placeDense, placeAffinity, hashString, type HierItem } from '../src/viz/hexgrid/placement';
import { hexNeighbors, hexDistance, axialToPixel, axialKey, type Axial } from '../src/viz/hexgrid/hex';

const NAMES = Array.from({ length: 120 }, (_, i) => `svc-${(i % 7)}-${i}`);

function placeAll(sizes: (name: string) => number): Axial[][] {
  const placer = new HexPlacer(30);
  return NAMES.map((n) => placer.place(n, sizes(n)).cells);
}

function isContiguous(cells: Axial[]): boolean {
  if (cells.length <= 1) return true;
  const set = new Set(cells.map(([q, r]) => axialKey(q, r)));
  const seen = new Set<string>();
  const stack: Axial[] = [cells[0]];
  while (stack.length) {
    const [q, r] = stack.pop() as Axial;
    const key = axialKey(q, r);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [nq, nr] of hexNeighbors(q, r)) {
      const nk = axialKey(nq, nr);
      if (set.has(nk) && !seen.has(nk)) stack.push([nq, nr]);
    }
  }
  return seen.size === cells.length;
}

describe('hashString', () => {
  it('is deterministic', () => {
    expect(hashString('payments-01')).toBe(hashString('payments-01'));
  });
  it('differs for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});

describe('HexPlacer', () => {
  it('is deterministic for the same names in the same order', () => {
    const a = placeAll(() => 1);
    const b = placeAll(() => 1);
    expect(a).toEqual(b);
  });

  it('never places two workloads on the same cell', () => {
    const all = placeAll((n) => (n.endsWith('3') ? 3 : 1)).flat();
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('claims a contiguous cluster for multi-cell workloads', () => {
    const placer = new HexPlacer(30);
    const big = placer.place('whale', 4);
    expect(big.cells).toHaveLength(4);
    expect(isContiguous(big.cells)).toBe(true);
  });

  it('keeps every multi-cell workload contiguous even when crowded', () => {
    const clusters = placeAll((n) => (n.charCodeAt(n.length - 1) % 3) + 1);
    for (const cells of clusters) expect(isContiguous(cells)).toBe(true);
  });
});

describe('HexPlacer.placeGrouped', () => {
  const GROUPS = ['a', 'b', 'c', 'd', 'e'];
  // Interleaved groups + a few multi-cell members, to stress bucketing.
  const items = Array.from({ length: 200 }, (_, i) => ({
    name: `r-${i}`,
    size: i % 37 === 0 ? 2 : 1,
    group: GROUPS[i % GROUPS.length],
  }));

  function cellsByGroup(placed: ReturnType<HexPlacer['placeGrouped']>): Map<string, Axial[]> {
    const byGroup = new Map<string, Axial[]>();
    placed.forEach((p, i) => {
      const g = items[i].group;
      const arr = byGroup.get(g) ?? [];
      arr.push(...p.cells);
      byGroup.set(g, arr);
    });
    return byGroup;
  }

  it('returns placements aligned to the input order', () => {
    const placed = new HexPlacer(30).placeGrouped(items);
    expect(placed.map((p) => p.name)).toEqual(items.map((it) => it.name));
  });

  it('is deterministic for the same input', () => {
    const a = new HexPlacer(30).placeGrouped(items).map((p) => p.cells);
    const b = new HexPlacer(30).placeGrouped(items).map((p) => p.cells);
    expect(a).toEqual(b);
  });

  it('gives each member exactly its requested cell count', () => {
    const placed = new HexPlacer(30).placeGrouped(items);
    placed.forEach((p, i) => expect(p.cells).toHaveLength(items[i].size));
  });

  it('never places two resources on the same cell', () => {
    const all = new HexPlacer(30).placeGrouped(items).flatMap((p) => p.cells);
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('packs every group into one contiguous blob (locality)', () => {
    const placed = new HexPlacer(30).placeGrouped(items);
    for (const [, cells] of cellsByGroup(placed)) {
      expect(isContiguous(cells)).toBe(true);
    }
  });
});

describe('placeHierarchical', () => {
  // 3 mgmt groups × 2 subscriptions × 2 resource groups × 5 resources.
  const items: HierItem[] = [];
  for (const mg of ['A', 'B', 'C']) {
    for (const sub of ['1', '2']) {
      for (const rg of ['x', 'y']) {
        for (let i = 0; i < 5; i++) {
          items.push({ name: `${mg}-${sub}-${rg}-${i}`, size: 1, path: [mg, sub, rg] });
        }
      }
    }
  }

  function cellsBy(placed: ReturnType<typeof placeHierarchical>, level: number): Map<string, Axial[]> {
    const by = new Map<string, Axial[]>();
    placed.forEach((p, i) => {
      const key = items[i].path.slice(0, level + 1).join('/');
      const arr = by.get(key) ?? [];
      arr.push(...p.cells);
      by.set(key, arr);
    });
    return by;
  }

  it('returns placements aligned to the input order', () => {
    const placed = placeHierarchical(items, [3, 1, 0]);
    expect(placed.map((p) => p.name)).toEqual(items.map((it) => it.name));
  });

  it('is deterministic for the same input', () => {
    const a = placeHierarchical(items, [3, 1, 0]).map((p) => p.cells);
    const b = placeHierarchical(items, [3, 1, 0]).map((p) => p.cells);
    expect(a).toEqual(b);
  });

  it('never places two resources on the same cell', () => {
    const all = placeHierarchical(items, [2, 1, 0]).flatMap((p) => p.cells);
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps each leaf resource group contiguous', () => {
    const placed = placeHierarchical(items, [3, 1, 0]);
    for (const [, cells] of cellsBy(placed, 2)) expect(isContiguous(cells)).toBe(true);
  });

  it('separates coarser groups by wider gaps than finer ones', () => {
    const placed = placeHierarchical(items, [4, 2, 0]);
    const minGap = (groups: Axial[][]): number => {
      let m = Infinity;
      for (let a = 0; a < groups.length; a++) {
        for (let b = a + 1; b < groups.length; b++) {
          for (const c1 of groups[a]) {
            for (const c2 of groups[b]) {
              m = Math.min(m, hexDistance(c1[0], c1[1], c2[0], c2[1]));
            }
          }
        }
      }
      return m;
    };
    // Top-level (mgmt group) boundaries use pad 4 → cells stay > 4 apart.
    expect(minGap([...cellsBy(placed, 0).values()])).toBeGreaterThan(4);
  });

  it('converges the footprint toward the target aspect ratio', () => {
    const big: HierItem[] = [];
    for (const mg of ['A', 'B', 'C', 'D']) {
      for (const sub of ['1', '2', '3']) {
        for (const rg of ['x', 'y', 'z']) {
          for (let i = 0; i < 12; i++) {
            big.push({ name: `${mg}-${sub}-${rg}-${i}`, size: 1, path: [mg, sub, rg] });
          }
        }
      }
    }
    const footprintRatio = (aspect: number): number => {
      const placed = placeHierarchical(big, [1, 0, 0], aspect);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of placed) {
        for (const [q, r] of p.cells) {
          const [px, py] = axialToPixel(q, r, 1);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
      return (maxX - minX) / (maxY - minY);
    };
    const wide = footprintRatio(16 / 9);
    // A 16:9 target must yield a clearly landscape footprint near 16:9.
    expect(wide).toBeGreaterThan(1.4);
    expect(wide).toBeLessThan(2.6);
  });
});

describe('placeDense', () => {
  // A hierarchy with many single-cell workloads and varied group sizes, to
  // stress the street-budgeted rectangle carve (like the estate demo).
  const items: HierItem[] = [];
  for (const hub of ['h0', 'h1', 'h2', 'h3', 'h4']) {
    for (let s = 0; s < 6; s++) {
      for (let g = 0; g < 4; g++) {
        for (let i = 0; i < 9; i++) {
          items.push({ name: `${hub}-s${s}-g${g}-${i}`, size: 1, path: [hub, `s${s}`, `g${g}`] });
        }
      }
    }
  }

  it('places every workload with exactly its requested cell count (no loss)', () => {
    const placed = placeDense(items);
    placed.forEach((p, i) => expect(p.cells).toHaveLength(items[i].size));
  });

  it('never places two workloads on the same cell', () => {
    const all = placeDense(items).flatMap((p) => p.cells);
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic for the same input', () => {
    const a = placeDense(items).map((p) => p.cells);
    const b = placeDense(items).map((p) => p.cells);
    expect(a).toEqual(b);
  });

  it('returns placements aligned to the input order', () => {
    const placed = placeDense(items);
    expect(placed.map((p) => p.name)).toEqual(items.map((it) => it.name));
  });

  it('keeps multi-cell workloads contiguous', () => {
    const multi: HierItem[] = [
      { name: 'a', size: 6, path: ['g', 'a'] },
      { name: 'b', size: 5, path: ['g', 'b'] },
      { name: 'c', size: 4, path: ['g', 'c'] },
    ];
    const sizeOf = new Map(multi.map((m) => [m.name, m.size]));
    for (const p of placeDense(multi)) {
      expect(p.cells).toHaveLength(sizeOf.get(p.name) ?? 0);
      expect(isContiguous(p.cells)).toBe(true);
    }
  });
});

describe('placeAffinity', () => {
  // Estate-shaped hierarchy: attribute vector [hub, workload, sub] + a
  // resource-group leaf. Each workload is homed in one hub (prod + dev subs).
  const items: HierItem[] = [];
  let n = 0;
  for (const hub of ['h0', 'h1', 'h2']) {
    for (const wl of ['a', 'b', 'c', 'd']) {
      const w = `${hub}-${wl}`; // each workload is homed in a single hub
      for (const env of ['prod', 'dev']) {
        const sub = `${hub}-${wl}-${env}`;
        for (let k = 0; k < 5; k++) {
          items.push({ name: `r${n++}`, size: 1, path: [hub, w, sub, `rg${k % 2}`] });
        }
      }
    }
  }

  it('places every resource with exactly its requested cell count (no loss)', () => {
    const placed = placeAffinity(items);
    placed.forEach((p, i) => expect(p.cells).toHaveLength(items[i].size));
  });

  it('never places two resources on the same cell', () => {
    const all = placeAffinity(items).flatMap((p) => p.cells);
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic for the same input', () => {
    const a = placeAffinity(items).map((p) => p.cells);
    const b = placeAffinity(items).map((p) => p.cells);
    expect(a).toEqual(b);
  });

  it('returns placements aligned to the input order', () => {
    const placed = placeAffinity(items);
    expect(placed.map((p) => p.name)).toEqual(items.map((it) => it.name));
  });

  it('keeps multi-cell territories contiguous', () => {
    const multi: HierItem[] = [
      { name: 'a', size: 6, path: ['h', 'w1', 's1', 'rg'] },
      { name: 'b', size: 5, path: ['h', 'w1', 's2', 'rg'] },
      { name: 'c', size: 4, path: ['h', 'w2', 's3', 'rg'] },
    ];
    const sizeOf = new Map(multi.map((m) => [m.name, m.size]));
    for (const p of placeAffinity(multi)) {
      expect(p.cells).toHaveLength(sizeOf.get(p.name) ?? 0);
      expect(isContiguous(p.cells)).toBe(true);
    }
  });

  it('places same-hub territories closer together than different-hub ones', () => {
    // Blast-radius intent: same-hub resources must cluster so a hub-wide incident
    // lights up one region. Compare mean centroid distance within vs across hubs.
    const placed = placeAffinity(items, { attrWeights: [1.4, 1.0, 0] });
    const byName = new Map(placed.map((p) => [p.name, p]));
    const sums = new Map<string, { x: number; y: number; n: number; hub: string }>();
    for (const it of items) {
      const [q, r] = byName.get(it.name)?.cells[0] ?? [0, 0];
      const sub = it.path[2];
      const e = sums.get(sub) ?? { x: 0, y: 0, n: 0, hub: it.path[0] };
      e.x += q;
      e.y += r;
      e.n += 1;
      sums.set(sub, e);
    }
    const cents = [...sums.values()].map((e) => ({ x: e.x / e.n, y: e.y / e.n, hub: e.hub }));
    let sameSum = 0;
    let sameN = 0;
    let diffSum = 0;
    let diffN = 0;
    for (let i = 0; i < cents.length; i++) {
      for (let j = i + 1; j < cents.length; j++) {
        const d = Math.hypot(cents[i].x - cents[j].x, cents[i].y - cents[j].y);
        if (cents[i].hub === cents[j].hub) {
          sameSum += d;
          sameN++;
        } else {
          diffSum += d;
          diffN++;
        }
      }
    }
    expect(sameSum / sameN).toBeLessThan(diffSum / diffN);
  });

  it('pulls shared (high-central) resources toward the centre of their cluster', () => {
    // One subscription blob mixing shared network cells (central 1) with ordinary
    // workload cells (central 0). The shared cells should end up nearer the core.
    const shared: HierItem[] = Array.from({ length: 8 }, (_, k) => ({
      name: `net${k}`,
      size: 1,
      path: ['h', 'w', 's', 'net'],
      central: 1,
    }));
    const leaf: HierItem[] = Array.from({ length: 40 }, (_, k) => ({
      name: `app${k}`,
      size: 1,
      path: ['h', 'w', 's', `rg${k % 4}`],
      central: 0,
    }));
    const all = [...shared, ...leaf];
    const byName = new Map(placeAffinity(all).map((p) => [p.name, p.cells[0]]));
    let cx = 0;
    let cy = 0;
    for (const [q, r] of byName.values()) {
      const [x, y] = axialToPixel(q, r, 1);
      cx += x;
      cy += y;
    }
    cx /= all.length;
    cy /= all.length;
    const meanDist = (group: HierItem[]): number => {
      let s = 0;
      for (const it of group) {
        const [q, r] = byName.get(it.name) ?? [0, 0];
        const [x, y] = axialToPixel(q, r, 1);
        s += Math.hypot(x - cx, y - cy);
      }
      return s / group.length;
    };
    expect(meanDist(shared)).toBeLessThan(meanDist(leaf));
  });
});

