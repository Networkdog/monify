// TreeMap demo — a live "cloud spend" explorer.
//
// A 4-level hierarchy (Org › Team › Service › Resource) where each leaf is a
// resource whose monthly cost wanders realistically (mean-reverting random walk
// with occasional cost spikes). Cell area = cost, color = cost (Viridis),
// height (Z) = utilization. Scroll to zoom, drag to pan, click a cell to dive
// into its nested treemap.

import { TreeMap, type TreeMapNode } from '../viz/treemap';
import { SEQUENTIAL } from '../color';
import { mulberry32, randRange, randInt, pick, drift } from './random';

const TEAMS = ['Platform', 'Payments', 'Search', 'Growth', 'Data', 'Mobile', 'Infra'];
const KINDS = ['api', 'worker', 'db', 'cache', 'cdn', 'queue', 'ml', 'auth'];

interface LeafSim {
  id: string;
  meta: { util: number; baseline: number; kind: string };
  cost: number;
  baseline: number;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildData(rng: () => number): { root: TreeMapNode; leaves: LeafSim[] } {
  const leaves: LeafSim[] = [];
  let uid = 0;
  const teams = shuffle(TEAMS, rng).slice(0, 5);
  const root: TreeMapNode = {
    id: 'org',
    label: 'Acme Cloud',
    value: 0,
    children: teams.map((team) => ({
      id: `team-${team}`,
      label: team,
      value: 0,
      children: Array.from({ length: randInt(rng, 3, 6) }, () => {
        const kind = pick(rng, KINDS);
        const serviceId = `svc-${uid++}`;
        return {
          id: serviceId,
          label: kind,
          value: 0,
          children: Array.from({ length: randInt(rng, 3, 7) }, (_, i) => {
            const id = `res-${uid++}`;
            const cost = Math.round(randRange(rng, 150, 9000));
            const meta = { util: randRange(rng, 0.1, 0.95), baseline: cost, kind };
            leaves.push({ id, meta, cost, baseline: cost });
            const leaf: TreeMapNode = {
              id,
              label: `${kind}-${i + 1}`,
              value: cost,
              category: KINDS.indexOf(kind),
              meta,
            };
            return leaf;
          }),
        };
      }),
    })),
  };
  return { root, leaves };
}

function currency(v: number): string {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function buildLegend(el: HTMLElement): void {
  const stops = SEQUENTIAL.viridis.join(', ');
  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:4px">cost / utilization</div>` +
    `<div style="height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops})"></div>` +
    `<div style="display:flex;justify-content:space-between;opacity:0.75;margin-top:2px">` +
    `<span>low</span><span>high &nbsp;·&nbsp; taller = higher util</span></div>`;
}

function main(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const legend = document.getElementById('legend') as HTMLDivElement;

  const rng = mulberry32(42);
  const { root, leaves } = buildData(rng);

  const tm = new TreeMap(canvas, {
    data: root,
    colorBy: 'value',
    palette: 'viridis',
    heightMetric: (n) =>
      n.meta && typeof n.meta.util === 'number' ? (n.meta.util as number) : 0,
    tweenRate: 3.5,
  });

  buildLegend(legend);

  // Realistic drift: every 600ms nudge every resource's cost + utilization.
  let ticks = 0;
  setInterval(() => {
    ticks++;
    const values: Record<string, number> = {};
    for (const leaf of leaves) {
      leaf.cost = drift(
        leaf.cost,
        { min: 50, max: 16000, mean: leaf.baseline, reversion: 0.05, volatility: 0.02 },
        rng,
      );
      leaf.meta.util = drift(
        leaf.meta.util,
        { min: 0.05, max: 1, mean: 0.55, reversion: 0.04, volatility: 0.04 },
        rng,
      );
      values[leaf.id] = leaf.cost;
    }
    // Every ~9s, a small cluster of resources spikes (a cost incident).
    if (ticks % 15 === 0) {
      for (let i = 0; i < 6; i++) {
        const leaf = pick(rng, leaves);
        leaf.cost = Math.min(16000, leaf.cost + randRange(rng, 3000, 8000));
        values[leaf.id] = leaf.cost;
      }
    }
    tm.setValues(values);
  }, 600);

  setInterval(() => {
    const info = tm.rootInfo;
    hud.textContent =
      `${tm.fps} fps · total ${currency(info.value)} · ${info.leafCount} resources · ` +
      `zoom ${tm.scene.camera.zoom.toFixed(1)}`;
  }, 250);
}

main();
