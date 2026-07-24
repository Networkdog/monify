import { describe, it, expect } from 'vitest';
import { placeAffinity, type HierItem } from '../src/viz/hexgrid/placement';
import { hexNeighbors, axialKey } from '../src/viz/hexgrid/hex';

// A synthetic estate shaped like the demo: 10 hubs, each with a connectivity
// subscription plus many prod/dev workload subscriptions, tagged with `central`
// by resource kind. Large enough to reproduce the force-directed layout's
// density profile from a hub's centre out to its edge.
function buildEstate(): HierItem[] {
  const items: HierItem[] = [];
  let seq = 0;
  const emit = (hub: string, wl: string, sub: string, rg: string, central: number): void => {
    items.push({ name: `r${seq++}`, size: 1, path: [hub, wl, sub, rg], central });
  };
  for (let h = 0; h < 10; h++) {
    const hub = `hub${h}`;
    for (let k = 0; k < 6; k++) emit(hub, 'connectivity', `sub-conn-${h}`, 'rg-conn', 1.0);
    for (let k = 0; k < 6; k++) emit(hub, 'connectivity', `sub-conn-${h}`, 'rg-mgmt', 0.3);
    for (let w = 0; w < 20; w++) {
      const wl = `wl${h}-${w}`;
      for (const env of ['prod', 'dev']) {
        const sub = `sub-${wl}-${env}`;
        for (let k = 0; k < 5; k++) emit(hub, wl, sub, 'rg-net', 0.8);
        for (let k = 0; k < 6; k++) emit(hub, wl, sub, 'rg-web', 0.1);
        for (let k = 0; k < 7; k++) emit(hub, wl, sub, 'rg-app', 0.1);
        for (let k = 0; k < 4; k++) emit(hub, wl, sub, 'rg-data', 0.15);
      }
    }
  }
  return items;
}

// Cross-workload "no-moat" contact density (share of same-hub neighbour pairs
// that touch a different workload without a gap) bucketed by normalised distance
// from the hub centre, centre → edge.
function crossWorkloadDensityByRadius(items: HierItem[], buckets: number): number[] {
  const placed = placeAffinity(items, { attrWeights: [1.1, 1.3, 0] });
  const info = new Map<string, { wl: string; hub: string; q: number; r: number }>();
  const cellsOf = new Map<string, [number, number][]>();
  placed.forEach((p, i) => {
    const [hub, wl] = items[i].path;
    for (const [q, r] of p.cells) {
      info.set(axialKey(q, r), { wl, hub, q, r });
      const arr = cellsOf.get(hub) ?? [];
      arr.push([q, r]);
      cellsOf.set(hub, arr);
    }
  });
  const centre = new Map<string, [number, number]>();
  const radius = new Map<string, number>();
  for (const [hub, cells] of cellsOf) {
    let cq = 0;
    let cr = 0;
    for (const [q, r] of cells) {
      cq += q;
      cr += r;
    }
    cq /= cells.length;
    cr /= cells.length;
    centre.set(hub, [cq, cr]);
    let mx = 1e-6;
    for (const [q, r] of cells) mx = Math.max(mx, Math.hypot(q - cq, r - cr));
    radius.set(hub, mx);
  }
  const viol = new Array(buckets).fill(0);
  const cells = new Array(buckets).fill(0);
  for (const it of info.values()) {
    const [cq, cr] = centre.get(it.hub) as [number, number];
    const d = Math.hypot(it.q - cq, it.r - cr) / (radius.get(it.hub) as number);
    const b = Math.min(buckets - 1, Math.floor(d * buckets));
    cells[b]++;
    for (const [nq, nr] of hexNeighbors(it.q, it.r)) {
      const nb = info.get(axialKey(nq, nr));
      if (nb && nb.hub === it.hub && nb.wl !== it.wl) viol[b]++;
    }
  }
  return viol.map((v, i) => v / Math.max(1, cells[i]));
}

describe('placeAffinity — uniform gaps from centre to edge', () => {
  // Regression guard: the old force-directed layout collapsed every hub's
  // territories onto its centre point, so the middle of each hub was a packed
  // core with no gaps between workloads while only the rim showed moats. Seeding
  // each territory at (and anchoring it to) its own spread position keeps the
  // density even, so the innermost ring must not be a packing spike.
  it('does not pack the hub centre denser than the rest', () => {
    const dens = crossWorkloadDensityByRadius(buildEstate(), 5);
    const mean = dens.reduce((s, v) => s + v, 0) / dens.length;
    // The centre bucket used to sit far above the mean (a solid core); it must
    // now stay near it. A real spike (the old bug) was several times the mean.
    expect(dens[0]).toBeLessThanOrEqual(mean * 1.5);
    // And the centre must not be the densest ring.
    expect(dens[0]).toBeLessThanOrEqual(Math.max(dens[1], dens[2], dens[3]));
  });

  it('separates every workload by at least one empty cell (no two workloads touch)', () => {
    // The gap the user asked for: within a hub, no cell of one workload may be
    // hex-adjacent to a cell of another. A stalled blob is allowed to fragment
    // to honour this, but the moat between workloads is never eaten.
    const items = buildEstate();
    const placed = placeAffinity(items, { attrWeights: [1.1, 1.3, 0] });
    const info = new Map<string, { hub: string; wl: string }>();
    placed.forEach((p, i) => {
      const [hub, wl] = items[i].path;
      for (const [q, r] of p.cells) info.set(axialKey(q, r), { hub, wl });
    });
    let touching = 0;
    for (const [key, a] of info) {
      const [q, r] = key.split(',').map(Number);
      for (const [nq, nr] of hexNeighbors(q, r)) {
        const b = info.get(axialKey(nq, nr));
        if (b && b.hub === a.hub && b.wl !== a.wl) touching++;
      }
    }
    expect(touching).toBe(0);
  });

  it('is deterministic', () => {
    const a = crossWorkloadDensityByRadius(buildEstate(), 5);
    const b = crossWorkloadDensityByRadius(buildEstate(), 5);
    expect(a).toEqual(b);
  });
});
