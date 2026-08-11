// Extreme benchmark for the WorkloadStore data plane.
//
// Measures the three things that decide whether a 60 FPS render loop is even
// possible, independent of the GPU:
//   1. cold ingest of a very large estate,
//   2. steady-state streaming cost per tick (main-thread blocking time),
//   3. resident memory and GC pause behaviour.
//
// Run:  npx vite-node bench/store-bench.ts [nodeCount] [churnFraction]
// GC detail: node --expose-gc via NODE_OPTIONS for forced-collection accuracy.

import { PerformanceObserver, performance } from 'node:perf_hooks';
import { WorkloadStore } from '../src/viz/workload-map/store';
import type { NodeInput } from '../src/viz/workload-map/types';

const TOTAL = Number(process.argv[2] ?? 1_000_000);
const CHURN = Number(process.argv[3] ?? 1);
// 0 forces incremental rollups; a tiny value forces the rebuild path.
const CROSSOVER = Number(process.argv[4] ?? 0.05);
const TICKS = 100;
const TICK_MS = 50;
const FRAME_BUDGET_MS = 16.7;

const CLUSTERS = 20;
const WORKLOADS = 1_000;

interface GcStat {
  count: number;
  totalMs: number;
  maxMs: number;
}
const gc: GcStat = { count: 0, totalMs: 0, maxMs: 0 };
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.count++;
    gc.totalMs += entry.duration;
    if (entry.duration > gc.maxMs) gc.maxMs = entry.duration;
  }
});
gcObserver.observe({ entryTypes: ['gc'] });

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function forceGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === 'function') g.gc();
}

/** Deterministic xorshift so runs are comparable. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

console.log('=== monify WorkloadStore — extreme benchmark ===');
console.log(`node ${process.version} | platform ${process.platform}`);
console.log(
  `target: ${fmt(TOTAL)} resources / ${fmt(WORKLOADS)} workloads / ${fmt(CLUSTERS)} clusters`,
);
console.log(
  `rollup strategy: ${CROSSOVER <= 0 ? 'incremental only' : `rebuild above ${(CROSSOVER * 100).toFixed(4)}% of estate`}`,
);
console.log('');

// ── Phase A: cold ingest ────────────────────────────────────────────────────
forceGc();
const heapBefore = process.memoryUsage().heapUsed;

const store = new WorkloadStore({ capacity: TOTAL + WORKLOADS + CLUSTERS + 16, rebuildCrossover: CROSSOVER });
const rng = makeRng(0xc0ffee);

const t0 = performance.now();
const topology: NodeInput[] = [];
for (let c = 0; c < CLUSTERS; c++) topology.push({ id: `c${c}`, kind: 'cluster' });
for (let w = 0; w < WORKLOADS; w++) {
  topology.push({ id: `w${w}`, kind: 'workload', parent: `c${w % CLUSTERS}` });
}
store.applyBatch(topology);

// Ingest resources in chunks so the record array itself never dominates RSS.
const CHUNK = 50_000;
let chunk: NodeInput[] = [];
for (let i = 0; i < TOTAL; i++) {
  chunk.push({
    id: `r${i}`,
    kind: 'resource',
    parent: `w${i % WORKLOADS}`,
    health: rng() * 0.35,
  });
  if (chunk.length === CHUNK) {
    store.applyBatch(chunk);
    chunk = [];
  }
}
if (chunk.length > 0) store.applyBatch(chunk);
const ingestMs = performance.now() - t0;

forceGc();
const heapAfter = process.memoryUsage().heapUsed;

console.log('--- cold ingest ---');
console.log(`nodes live            : ${fmt(store.size)}`);
console.log(`ingest wall time      : ${ingestMs.toFixed(1)} ms`);
console.log(`ingest throughput     : ${fmt(Math.round(store.size / (ingestMs / 1000)))} nodes/s`);
console.log(`columnar state (exact): ${mb(store.columnBytes)}`);
console.log(`heap delta            : ${mb(heapAfter - heapBefore)}`);
console.log(`rss                   : ${mb(process.memoryUsage().rss)}`);
console.log('');

// ── Phase B: handle resolution (done once, then reused every tick) ──────────
const tRes = performance.now();
const allHandles = new Int32Array(TOTAL);
for (let i = 0; i < TOTAL; i++) allHandles[i] = store.handleOf(`r${i}`);
const resolveMs = performance.now() - tRes;
console.log('--- handle resolution (one-off) ---');
console.log(`resolve ${fmt(TOTAL)} ids  : ${resolveMs.toFixed(1)} ms`);
console.log('');

// ── Phase C: steady-state streaming ─────────────────────────────────────────
const churnCount = Math.max(1, Math.round(TOTAL * CHURN));
const tickHandles = new Int32Array(churnCount);
const tickValues = new Float32Array(churnCount);

const gcBefore = { ...gc };
const applyTimes: number[] = [];
const drainTimes: number[] = [];
let totalApplied = 0;
let totalDirty = 0;

for (let tick = 0; tick < TICKS; tick++) {
  // Spiky workload: a moving hot window plus scattered random incidents, so
  // the run exercises both dense locality and cache-hostile scatter.
  const base = (tick * 7919) % TOTAL;
  for (let i = 0; i < churnCount; i++) {
    const idx = i < churnCount / 2 ? (base + i) % TOTAL : (rng() * TOTAL) | 0;
    tickHandles[i] = allHandles[idx];
    tickValues[i] = rng() < 0.02 ? 0.8 + rng() * 0.2 : rng() * 0.35;
  }

  const a0 = performance.now();
  totalApplied += store.applyHealthBulk(tickHandles, tickValues, churnCount);
  applyTimes.push(performance.now() - a0);

  const d0 = performance.now();
  const dirty = store.drainDirty();
  totalDirty += dirty.length;
  drainTimes.push(performance.now() - d0);
}

const gcDuring: GcStat = {
  count: gc.count - gcBefore.count,
  totalMs: gc.totalMs - gcBefore.totalMs,
  maxMs: gc.maxMs,
};

applyTimes.sort((a, b) => a - b);
drainTimes.sort((a, b) => a - b);
const combined = applyTimes.map((v, i) => v + drainTimes[i]).sort((a, b) => a - b);

console.log('--- steady-state streaming ---');
console.log(`updates per tick      : ${fmt(churnCount)} (${(CHURN * 100).toFixed(1)}% of estate)`);
console.log(`ticks                 : ${TICKS} @ ${TICK_MS} ms nominal`);
console.log(`applied total         : ${fmt(totalApplied)}`);
console.log(`dirty handles emitted : ${fmt(totalDirty)} (avg ${fmt(Math.round(totalDirty / TICKS))}/tick)`);
console.log('');
console.log(`apply  p50/p95/p99/max: ${pct(applyTimes, 50).toFixed(2)} / ${pct(applyTimes, 95).toFixed(2)} / ${pct(applyTimes, 99).toFixed(2)} / ${applyTimes[applyTimes.length - 1].toFixed(2)} ms`);
console.log(`drain  p50/p95/p99/max: ${pct(drainTimes, 50).toFixed(3)} / ${pct(drainTimes, 95).toFixed(3)} / ${pct(drainTimes, 99).toFixed(3)} / ${drainTimes[drainTimes.length - 1].toFixed(3)} ms`);
console.log(`total  p50/p95/p99/max: ${pct(combined, 50).toFixed(2)} / ${pct(combined, 95).toFixed(2)} / ${pct(combined, 99).toFixed(2)} / ${combined[combined.length - 1].toFixed(2)} ms`);
console.log('');
const throughput = totalApplied / (applyTimes.reduce((s, v) => s + v, 0) / 1000);
console.log(`update throughput     : ${fmt(Math.round(throughput))} updates/s`);
console.log(`gc during streaming   : ${gcDuring.count} collections, ${gcDuring.totalMs.toFixed(1)} ms total, ${gcDuring.maxMs.toFixed(2)} ms worst pause`);

forceGc();
const heapSteady = process.memoryUsage().heapUsed;
console.log(`heap after streaming  : ${mb(heapSteady)} (delta vs post-ingest ${mb(heapSteady - heapAfter)})`);
console.log('');

// ── Verdict against the stated budget ───────────────────────────────────────
const p95 = pct(combined, 95);
const budgetPass = p95 < FRAME_BUDGET_MS;
const leakPass = heapSteady - heapAfter < 8 * 1024 * 1024;
console.log('--- verdict ---');
console.log(`data plane fits ${FRAME_BUDGET_MS} ms frame budget at p95 : ${budgetPass ? 'PASS' : 'FAIL'} (${p95.toFixed(2)} ms)`);
console.log(`no steady-state heap growth                  : ${leakPass ? 'PASS' : 'FAIL'}`);
console.log(`sustainable updates/s at 60 FPS              : ${fmt(Math.round(throughput * (FRAME_BUDGET_MS / 1000)))} per frame`);
console.log('');
console.log('note: this measures the CPU data plane only. GPU frame rate must be');
console.log('measured in a browser with the WebGL renderer attached.');

gcObserver.disconnect();
