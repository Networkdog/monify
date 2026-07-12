// HexGrid demo — a live workload monitor.
//
// ~300 workloads laid out as a honeycomb, each placed at a name-determined
// position. Most stay healthy (green); occasionally one flares into an incident
// (pulsing red) then recovers. Cell color = criticality; larger workloads span
// several cells; zoom into a workload to see its per-resource sub-hexes. Hover
// for details, click to fly in.

import { HexGrid, type WorkloadInput } from '../viz/hexgrid';
import { DIVERGING } from '../color';
import { mulberry32, randRange, randInt, pick, drift } from './random';

const AREAS = ['edge', 'core', 'data', 'auth', 'pay', 'search', 'ml', 'stream', 'batch', 'web'];
const RES_KINDS = ['cpu', 'mem', 'net', 'disk', 'lat', 'err', 'io', 'gc'];
const WORKLOAD_COUNT = 300;

interface ResSim {
  id: string;
  sev: number;
  base: number;
}
interface WorkloadSim {
  name: string;
  baseCrit: number;
  crit: number;
  elevated: number; // ticks remaining
  highMean: number;
  resources: ResSim[];
}

function buildWorkloads(rng: () => number): { inputs: WorkloadInput[]; sims: WorkloadSim[] } {
  const inputs: WorkloadInput[] = [];
  const sims: WorkloadSim[] = [];
  const counters: Record<string, number> = {};
  for (let i = 0; i < WORKLOAD_COUNT; i++) {
    const area = pick(rng, AREAS);
    counters[area] = (counters[area] ?? 0) + 1;
    const name = `${area}-${String(counters[area]).padStart(2, '0')}`;
    const roll = rng();
    const size = roll < 0.8 ? 1 : roll < 0.92 ? 2 : roll < 0.98 ? 3 : 4;
    const baseCrit = randRange(rng, 0.04, 0.22);
    const nRes = randInt(rng, 3, 10);
    const resources: ResSim[] = Array.from({ length: nRes }, (_, r) => {
      const base = randRange(rng, 0.05, 0.3);
      return { id: `${RES_KINDS[r % RES_KINDS.length]}-${r}`, sev: base, base };
    });
    inputs.push({
      name,
      size,
      criticality: baseCrit,
      resources: resources.map((r) => ({ id: r.id, value: r.sev })),
    });
    sims.push({ name, baseCrit, crit: baseCrit, elevated: 0, highMean: 0.85, resources });
  }
  return { inputs, sims };
}

function buildLegend(el: HTMLElement): void {
  // rdylgn stops run red→green; reverse for a healthy→critical ramp.
  const stops = DIVERGING.rdylgn.slice().reverse().join(', ');
  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:4px">criticality</div>` +
    `<div style="height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops})"></div>` +
    `<div style="display:flex;justify-content:space-between;opacity:0.75;margin-top:2px">` +
    `<span>healthy</span><span>warning</span><span>critical</span></div>`;
}

function main(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const legend = document.getElementById('legend') as HTMLDivElement;

  const rng = mulberry32(7);
  const { inputs, sims } = buildWorkloads(rng);

  const grid = new HexGrid(canvas, { workloads: inputs, tweenRate: 4 });
  buildLegend(legend);

  setInterval(() => {
    for (const w of sims) {
      // Occasionally start an incident on a currently-healthy workload.
      if (w.elevated <= 0 && rng() < 0.004) {
        w.elevated = randInt(rng, 8, 22);
        w.highMean = randRange(rng, 0.7, 0.96);
        grid.triggerAnomaly(w.name, 1);
        // Elevate a couple of its resources too.
        for (let k = 0; k < 2; k++) pick(rng, w.resources).sev = randRange(rng, 0.7, 1);
      }
      const mean = w.elevated > 0 ? w.highMean : w.baseCrit;
      w.crit = drift(
        w.crit,
        { min: 0, max: 1, mean, reversion: w.elevated > 0 ? 0.18 : 0.06, volatility: 0.03 },
        rng,
      );
      if (w.elevated > 0) {
        w.elevated--;
        if (rng() < 0.25) grid.triggerAnomaly(w.name, 0.8);
      }
      grid.setCriticality(w.name, w.crit);
      for (const res of w.resources) {
        const rmean = w.elevated > 0 ? Math.max(res.base, 0.55) : res.base;
        res.sev = drift(
          res.sev,
          { min: 0, max: 1, mean: rmean, reversion: 0.08, volatility: 0.04 },
          rng,
        );
        grid.setResource(w.name, res.id, res.sev);
      }
    }
  }, 450);

  setInterval(() => {
    let critical = 0;
    let warning = 0;
    for (const w of sims) {
      if (w.crit > 0.75) critical++;
      else if (w.crit > 0.4) warning++;
    }
    hud.textContent =
      `${grid.fps} fps · ${sims.length} workloads · ${critical} critical · ${warning} warning · ` +
      `zoom ${grid.scene.camera.zoom.toFixed(1)}`;
  }, 250);
}

main();
