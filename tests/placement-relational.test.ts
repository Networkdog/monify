import { describe, it, expect } from 'vitest';
import { placeRelational, type RelItem, type PlacedWorkload } from '../src/viz/hexgrid/placement';
import { hexNeighbors, axialKey, axialToPixel, hexDistance } from '../src/viz/hexgrid/hex';

// A synthetic estate shaped like the demo: a shared platform management group
// holding one connectivity subscription per region, and a landing-zones
// management group holding the workload subscriptions. Every spoke VNet peers
// with its region's Virtual WAN hub, every NIC is attached to a VM and to the
// spoke VNet, and every disk hangs off its VM — so the layout has both a
// containment tree and a relationship graph to satisfy.
const REGIONS = 4;
const WORKLOADS = 6;

interface Estate {
  items: RelItem[];
  /** Virtual WAN hub resource per region. */
  hubOf: string[];
  /** Spoke VNet name per subscription. */
  vnetOf: Map<string, string>;
  /** VM → its NIC and disks. */
  attached: Map<string, string[]>;
}

function buildEstate(): Estate {
  const items: RelItem[] = [];
  const hubOf: string[] = [];
  const vnetOf = new Map<string, string>();
  const attached = new Map<string, string[]>();
  let seq = 0;
  const emit = (
    path: string[],
    code: string,
    central: number,
    deps: string[] = [],
    affinity: string[] = [],
  ): string => {
    const name = `${code}-${seq++}`;
    items.push({ name, size: 1, path, deps, central, affinity });
    return name;
  };

  for (let h = 0; h < REGIONS; h++) {
    const region = `region${h}`;
    const conn = ['platform', 'mg-connectivity', `sub-connectivity-${region}`, `rg-conn-${region}`];
    const vhub = emit(conn, 'VHUB', 1.0, [], [region]);
    hubOf.push(vhub);
    for (const code of ['FW', 'VPN', 'ER']) emit(conn, code, 0.9, [vhub], [region]);
  }

  for (let w = 0; w < WORKLOADS * REGIONS; w++) {
    const region = `region${w % REGIONS}`;
    const wl = `wl${w}`;
    for (const env of ['prod', 'dev']) {
      const sub = `sub-${wl}-${env}`;
      const mg = `mg-corp-${env}`;
      const aff = [region, wl];
      const netRg = ['landing-zones', mg, sub, `rg-${wl}-${env}-net`];
      // The spoke VNet is the subscription's magnet, peered to its region's hub.
      const vnet = emit(netRg, 'VNET', 0.92, [hubOf[w % REGIONS]], aff);
      vnetOf.set(sub, vnet);
      const nsg = emit(netRg, 'NSG', 0.5, [vnet], aff);
      const appRg = ['landing-zones', mg, sub, `rg-${wl}-${env}-app`];
      for (let v = 0; v < 3; v++) {
        const vm = emit(appRg, 'VM', 0.1, [], aff);
        const nic = emit(appRg, 'NIC', 0.2, [vm, vnet, nsg], aff);
        const disk = emit(appRg, 'DISK', 0.05, [vm], aff);
        attached.set(vm, [nic, disk]);
      }
      const dataRg = ['landing-zones', mg, sub, `rg-${wl}-${env}-data`];
      for (let d = 0; d < 4; d++) emit(dataRg, 'SQL', 0.15, [], aff);
    }
  }
  return { items, hubOf, vnetOf, attached };
}

function cellsByName(placed: PlacedWorkload[]): Map<string, [number, number][]> {
  return new Map(placed.map((p) => [p.name, p.cells]));
}

/** Pixel centre of a placed item (its first cell). */
function at(cells: Map<string, [number, number][]>, name: string): [number, number] {
  const c = cells.get(name);
  if (!c || c.length === 0) throw new Error(`unplaced: ${name}`);
  return axialToPixel(c[0][0], c[0][1], 1);
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

describe('placeRelational — containment', () => {
  const { items } = buildEstate();
  const placed = placeRelational(items, { affinityWeights: [1.2, 0.6] });

  it('places every resource on exactly the cells it asked for, with no overlap', () => {
    expect(placed).toHaveLength(items.length);
    const seen = new Set<string>();
    placed.forEach((p, i) => {
      expect(p.name).toBe(items[i].name);
      expect(p.cells).toHaveLength(Math.max(1, items[i].size ?? 1));
      for (const [q, r] of p.cells) {
        const k = axialKey(q, r);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    });
  });

  it('walls every resource group off — no cell touches another resource group', () => {
    const owner = new Map<string, string>();
    placed.forEach((p, i) => {
      const rg = items[i].path.join('/');
      for (const [q, r] of p.cells) owner.set(axialKey(q, r), rg);
    });
    let touching = 0;
    for (const [key, rg] of owner) {
      const [q, r] = key.split(',').map(Number);
      for (const nb of hexNeighbors(q, r)) {
        const other = owner.get(axialKey(nb[0], nb[1]));
        if (other !== undefined && other !== rg) touching++;
      }
    }
    expect(touching).toBe(0);
  });

  it('is deterministic', () => {
    const again = placeRelational(buildEstate().items, { affinityWeights: [1.2, 0.6] });
    expect(again.map((p) => p.cells)).toEqual(placed.map((p) => p.cells));
  });
});

describe('placeRelational — magnetism', () => {
  const estate = buildEstate();
  const placed = placeRelational(estate.items, { affinityWeights: [1.2, 0.6] });
  const cells = cellsByName(placed);

  it('clings a VM\u2019s NIC and disk to the VM itself', () => {
    // The direct test of the metaphor: what is wired together should end up on
    // touching cells, not merely somewhere in the same resource group.
    const cellOf = new Map<string, [number, number]>();
    estate.items.forEach((it, i) => {
      const c = placed[i].cells[0];
      if (c) cellOf.set(it.name, c);
    });
    let adjacent = 0;
    let total = 0;
    for (const [vm, parts] of estate.attached) {
      const a = cellOf.get(vm) as [number, number];
      for (const part of parts) {
        const b = cellOf.get(part) as [number, number];
        total++;
        if (hexDistance(a[0], a[1], b[0], b[1]) === 1) adjacent++;
      }
    }
    expect(adjacent / total).toBeGreaterThan(0.5);
  });

  it('keeps attached resources closer than the spread of their resource group', () => {
    const rgOf = new Map<string, string>();
    estate.items.forEach((it) => rgOf.set(it.name, it.path.join('/')));
    const byRg = new Map<string, string[]>();
    for (const [name, rg] of rgOf) {
      const arr = byRg.get(rg);
      if (arr) arr.push(name);
      else byRg.set(rg, [name]);
    }
    let attachedSum = 0;
    let attachedN = 0;
    let groupSum = 0;
    let groupN = 0;
    for (const [vm, parts] of estate.attached) {
      const p = at(cells, vm);
      for (const part of parts) {
        attachedSum += dist(p, at(cells, part));
        attachedN++;
      }
      for (const other of byRg.get(rgOf.get(vm) as string) ?? []) {
        if (other === vm) continue;
        groupSum += dist(p, at(cells, other));
        groupN++;
      }
    }
    expect(attachedSum / attachedN).toBeLessThan((groupSum / groupN) * 0.95);
  });

  it('pulls each spoke VNet to the hub-facing side of its subscription', () => {
    // The VNet is the only resource peered across the subscription wall, so it
    // should sit nearer its region's hub than the subscription's centre does.
    let nearer = 0;
    let total = 0;
    const subCells = new Map<string, [number, number][]>();
    estate.items.forEach((it, i) => {
      const sub = it.path[2];
      const arr = subCells.get(sub);
      if (arr) arr.push(...placed[i].cells);
      else subCells.set(sub, [...placed[i].cells]);
    });
    for (const [sub, vnet] of estate.vnetOf) {
      const region = Number(sub.match(/wl(\d+)/)?.[1] ?? 0) % REGIONS;
      const hub = at(cells, estate.hubOf[region]);
      const all = subCells.get(sub) as [number, number][];
      let cx = 0;
      let cy = 0;
      for (const [q, r] of all) {
        const [x, y] = axialToPixel(q, r, 1);
        cx += x;
        cy += y;
      }
      const centre: [number, number] = [cx / all.length, cy / all.length];
      total++;
      if (dist(at(cells, vnet), hub) < dist(centre, hub)) nearer++;
    }
    expect(nearer / total).toBeGreaterThan(0.75);
  });

  it('settles the shared connectivity subscriptions in the middle of the estate', () => {
    // Everything peers with them, so the platform enclave should end up nearer
    // the estate's centre of mass than an ordinary landing-zone resource.
    let cx = 0;
    let cy = 0;
    let n = 0;
    const platform: [number, number][] = [];
    const zone: [number, number][] = [];
    estate.items.forEach((it, i) => {
      for (const [q, r] of placed[i].cells) {
        const p = axialToPixel(q, r, 1);
        cx += p[0];
        cy += p[1];
        n++;
        (it.path[0] === 'platform' ? platform : zone).push(p);
      }
    });
    const centre: [number, number] = [cx / n, cy / n];
    const mean = (pts: [number, number][]): number =>
      pts.reduce((s, p) => s + dist(p, centre), 0) / pts.length;
    expect(mean(platform)).toBeLessThan(mean(zone));
  });

  it('lays wiring far shorter than the same cells shuffled inside their groups', () => {
    // Total wire length is the objective the layout is tuned for, so pin it
    // against a link-blind baseline: keep every cell and every wall, and only
    // shuffle which resource sits in which cell of its own resource group.
    const cells = cellsByName(placed);
    const wire = (pos: Map<string, [number, number]>): number => {
      let total = 0;
      let n = 0;
      for (const it of estate.items) {
        for (const dep of it.deps ?? []) {
          const a = pos.get(it.name);
          const b = pos.get(dep);
          if (!a || !b) continue;
          total += hexDistance(a[0], a[1], b[0], b[1]);
          n++;
        }
      }
      return total / n;
    };
    const cellAt = (name: string): [number, number] => {
      const c = cells.get(name);
      if (!c || c.length === 0) throw new Error(`unplaced: ${name}`);
      return c[0];
    };
    const actual = new Map(estate.items.map((it) => [it.name, cellAt(it.name)]));

    let seed = 20260811;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const byGroup = new Map<string, string[]>();
    for (const it of estate.items) {
      const key = it.path.join('/');
      const list = byGroup.get(key);
      if (list) list.push(it.name);
      else byGroup.set(key, [it.name]);
    }
    const shuffled = new Map<string, [number, number]>();
    for (const names of byGroup.values()) {
      const spots = names.map((nm) => cellAt(nm));
      for (let i = spots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [spots[i], spots[j]] = [spots[j], spots[i]];
      }
      names.forEach((nm, i) => shuffled.set(nm, spots[i]));
    }

    // The margin is modest because this fixture's resource groups are only a few
    // cells across, where even a random arrangement keeps everything close. It
    // still catches the layout going link-blind, which is how the wiring
    // regressed before.
    expect(wire(actual)).toBeLessThan(wire(shuffled) * 0.9);
  });
});
