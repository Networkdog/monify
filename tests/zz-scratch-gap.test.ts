import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { expandEstate } from '../src/demo/estate-data';
import { placeForce, type ForceItem } from '../src/viz/hexgrid/force-layout';
import { axialToPixel, hexDistance, axialKey, hexNeighbors } from '../src/viz/hexgrid/hex';
import type { PlacedWorkload } from '../src/viz/hexgrid/placement';

const file = JSON.parse(readFileSync('public/estate.json', 'utf8'));
const est = expandEstate(file);
const items: ForceItem[] = est.targets.map((t) => ({
  name: t.name,
  size: 1,
  path: [t.mg, t.sub, t.rg],
  deps: t.deps.map((d) => (typeof d === 'string' ? d : d.id)),
  central: t.central,
  anchor: t.hub,
}));
const subOf = new Map(est.targets.map((t) => [t.name, t.sub]));
const hubOfSub = new Map(est.targets.map((t) => [t.sub, t.hub]));
const mgOfSub = new Map(est.targets.map((t) => [t.sub, t.mg]));

function measure(strangerGap: number): void {
  const t0 = Date.now();
  const placed = placeForce(items, {
    cohesion: [0.012, 0.03, 0.075, 0.16],
    moats: [4, 2, 1],
    linkK: 0.035,
    anchorK: 0.014,
    strangerGap,
  });
  const ms = Date.now() - t0;
  const at = new Map(placed.map((p) => [p.name, p]));
  const cell = (n: string): PlacedWorkload['cells'][number] | undefined => at.get(n)?.cells[0];

  let dist = 0;
  let links = 0;
  for (const it2 of items) {
    for (const dep of it2.deps ?? []) {
      const a = cell(it2.name);
      const b = cell(dep);
      if (!a || !b) continue;
      dist += hexDistance(a[0], a[1], b[0], b[1]);
      links++;
    }
  }

  let minQ = Infinity;
  let maxQ = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  let cells = 0;
  const owner = new Map<string, string>();
  for (const p of placed) {
    for (const [q, r] of p.cells) {
      cells++;
      owner.set(axialKey(q, r), p.name);
      if (q < minQ) minQ = q;
      if (q > maxQ) maxQ = q;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  const fill = cells / ((maxQ - minQ + 1) * (maxR - minR + 1));

  let sameHub = 0;
  let crossHub = 0;
  let sameHubIn = 0;
  let crossHubIn = 0;
  for (const p of placed) {
    const mine = subOf.get(p.name);
    for (const [q, r] of p.cells) {
      for (const [nq, nr] of hexNeighbors(q, r)) {
        const other = owner.get(axialKey(nq, nr));
        if (other === undefined) continue;
        const theirs = subOf.get(other);
        if (theirs === undefined || theirs === mine) continue;
        const hit = hubOfSub.get(mine!) === hubOfSub.get(theirs);
        if (hit) sameHub++;
        else crossHub++;
        // Same management group only: strips out the discrete flips of whether
        // two giant MGs happen to abut, which swamp the global number.
        if (mgOfSub.get(mine!) !== mgOfSub.get(theirs)) continue;
        if (hit) sameHubIn++;
        else crossHubIn++;
      }
    }
  }

  const acc = new Map<string, [number, number, number]>();
  for (const p of placed) {
    const s = subOf.get(p.name)!;
    const a = acc.get(s) ?? [0, 0, 0];
    for (const [q, r] of p.cells) {
      const [x, y] = axialToPixel(q, r, 1);
      a[0] += x;
      a[1] += y;
      a[2]++;
    }
    acc.set(s, a);
  }
  const subs = [...acc.keys()];
  let same = 0;
  let sameN = 0;
  let cross = 0;
  let crossN = 0;
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      if (mgOfSub.get(subs[i]) === mgOfSub.get(subs[j])) continue;
      const a = acc.get(subs[i])!;
      const b = acc.get(subs[j])!;
      const d = Math.hypot(a[0] / a[2] - b[0] / b[2], a[1] / a[2] - b[1] / b[2]);
      if (hubOfSub.get(subs[i]) === hubOfSub.get(subs[j])) {
        same += d;
        sameN++;
      } else {
        cross += d;
        crossN++;
      }
    }
  }

  console.log({
    strangerGap,
    ms,
    fill: fill.toFixed(3),
    wire: (dist / links).toFixed(2),
    hubTouch: (sameHub / (sameHub + crossHub)).toFixed(3),
    hubTouchInMg: (sameHubIn / (sameHubIn + crossHubIn)).toFixed(3),
    hubRatio: (same / sameN / (cross / crossN)).toFixed(3),
  });
}

it('stranger gap sweep', () => {
  for (const g of [1, 1.2, 1.5, 1.8, 2.2, 2.5, 3]) measure(g);
}, 900000);
