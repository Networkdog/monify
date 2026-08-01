// Diagnostic: does placeAffinity actually give each resource group ONE blob?
// Mirrors the workload-map demo's shape without needing a DOM.
import { placeAffinity } from '../src/viz/hexgrid/placement';
import type { HierItem } from '../src/viz/hexgrid/placement';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260731);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

const MG_SPECS = [
  { leaf: 'mg-connectivity', subs: 1, platform: true },
  { leaf: 'mg-identity', subs: 1, platform: true },
  { leaf: 'mg-management', subs: 1, platform: true },
  { leaf: 'mg-security', subs: 1, platform: true },
  { leaf: 'mg-corp', subs: 22, platform: false },
  { leaf: 'mg-online', subs: 11, platform: false },
  { leaf: 'mg-sandbox', subs: 3, platform: false },
  { leaf: 'mg-decommissioned', subs: 1, platform: true },
];

const items: HierItem[] = [];
const rgSize = new Map<string, number>();
const rgOfCell: string[] = [];

const subs: { id: string; mg: string; platform: boolean }[] = [];
for (const spec of MG_SPECS) {
  for (let i = 0; i < spec.subs; i++) {
    subs.push({ id: `${spec.leaf}/sub-${i}`, mg: spec.leaf, platform: spec.platform });
  }
}

const RESOURCE_GROUPS = 500;
const rgPerSub = new Int32Array(subs.length);
let fixed = 0;
subs.forEach((s, i) => {
  if (s.platform || s.mg === 'mg-sandbox') {
    rgPerSub[i] = 2;
    fixed += 2;
  }
});
const appIdx = subs.map((s, i) => (s.platform || s.mg === 'mg-sandbox' ? -1 : i)).filter((i) => i >= 0);
let remaining = RESOURCE_GROUPS - fixed;
const weights = appIdx.map(() => 0.5 + rng() * 1.5);
const wsum = weights.reduce((a, b) => a + b, 0);
appIdx.forEach((si, k) => {
  const share = k === appIdx.length - 1 ? remaining : Math.min(remaining, Math.round((weights[k] / wsum) * remaining));
  rgPerSub[si] = share;
  remaining -= share;
});
if (remaining > 0) rgPerSub[appIdx[appIdx.length - 1]] += remaining;

let rgIndex = 0;
for (let si = 0; si < subs.length; si++) {
  const sub = subs[si];
  for (let g = 0; g < rgPerSub[si] && rgIndex < RESOURCE_GROUPS; g++, rgIndex++) {
    const rg = `rg-${rgIndex}`;
    const n = sub.platform ? randInt(50, 200) : randInt(30, 50);
    rgSize.set(rg, n);
    for (let k = 0; k < n; k++) {
      items.push({
        name: `${rg}/res-${k}`,
        size: 1,
        path: [sub.mg, sub.id, rg, `k${String(k).padStart(4, '0')}`],
        central: k === 0 ? 1 : k < 6 ? 0.7 : k < n * 0.7 ? 0.4 : 0.2,
      });
    }
  }
}

const t0 = performance.now();
const placed = placeAffinity(items, { attrWeights: [1.3, 1.1, 0.9] });
const ms = performance.now() - t0;

// Collect cells per resource group.
const cellsOf = new Map<string, [number, number][]>();
placed.forEach((p, i) => {
  const rg = items[i].path[2];
  let arr = cellsOf.get(rg);
  if (!arr) cellsOf.set(rg, (arr = []));
  for (const c of p.cells) arr.push(c as [number, number]);
});

const NB: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

function components(cells: [number, number][]): number[] {
  const set = new Set(cells.map(([q, r]) => `${q},${r}`));
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const key of set) {
    if (seen.has(key)) continue;
    let n = 0;
    const stack = [key];
    seen.add(key);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      n++;
      const [q, r] = cur.split(',').map(Number);
      for (const [dq, dr] of NB) {
        const nk = `${q + dq},${r + dr}`;
        if (set.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

let single = 0;
let missing = 0;
const largestFrac: number[] = [];
const compCounts: number[] = [];
for (const [rg, cells] of cellsOf) {
  const want = rgSize.get(rg) ?? 0;
  if (cells.length < want) missing += want - cells.length;
  const comps = components(cells);
  compCounts.push(comps.length);
  if (comps.length === 1) single++;
  largestFrac.push(cells.length > 0 ? comps[0] / cells.length : 0);
}
compCounts.sort((a, b) => a - b);
largestFrac.sort((a, b) => a - b);
const pct = (arr: number[], p: number): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

let placedCells = 0;
for (const p of placed) placedCells += p.cells.length;

// Reproduce the viz's fit maths to find the zoom at which a resource cell is
// large enough on screen to hold its metric cells.
const SQ3 = Math.sqrt(3);
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const p of placed) {
  for (const [q, r] of p.cells) {
    const px = SQ3 * (q + r / 2);
    const py = 1.5 * r;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
}
const fitScale = 0.9 / Math.max(maxX - minX + 2, maxY - minY + 2, 1e-6);
const TILE = 256;
const zFor = (px: number): number => Math.log2(px / (2 * fitScale * TILE));

process.stdout.write(
  [
    `items            ${items.length}`,
    `resource groups  ${cellsOf.size}`,
    `cells placed     ${placedCells} (dropped ${items.length - placedCells})`,
    `layout time      ${ms.toFixed(0)} ms`,
    '',
    `single-blob RGs  ${single} / ${cellsOf.size}  (${((single / cellsOf.size) * 100).toFixed(1)}%)`,
    `components  p50 ${pct(compCounts, 0.5)}  p90 ${pct(compCounts, 0.9)}  max ${compCounts[compCounts.length - 1]}`,
    `largest-frac p10 ${pct(largestFrac, 0.1).toFixed(2)}  p50 ${pct(largestFrac, 0.5).toFixed(2)}`,
    '',
    `world hex radius ${fitScale.toExponential(3)}`,
    `zoom for cellPx  200 -> ${zFor(200).toFixed(2)}   400 -> ${zFor(400).toFixed(2)}   800 -> ${zFor(800).toFixed(2)}`,
    '',
  ].join('\n'),
);
