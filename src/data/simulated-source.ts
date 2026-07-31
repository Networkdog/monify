// SimulatedSource — a deterministic in-process DataSource for demos and tests.
//
// It promotes the estate demo's incident model into a reusable adapter: healthy
// entities drift around a baseline while correlated incidents strike whole
// groups at once (a "blast radius"), so related entities light up together —
// exactly what a monitoring wall needs to look alive without a real backend.
//
// Feeding it `groups` coarse→fine (e.g. [hub, subscription, resourceGroup])
// makes coarse groups rarer but wider and fine groups frequent but local.

import type {
  ConnectionState,
  DataListener,
  DataSource,
  EntityUpdate,
  ResourceUpdate,
  StateListener,
} from './types';

export interface SimEntity {
  /** Stable entity id (matches a visualization entity's id). */
  id: string;
  /** Healthy severity this entity drifts around. Default 0.08. */
  baseline?: number;
  /** Correlation group keys coarse→fine; a group can be struck as a unit. */
  groups?: readonly string[];
  /** Sub-resource ids to emit severities for. */
  resources?: readonly string[];
}

export interface SimulatedSourceOptions {
  /** Entities to simulate. */
  entities: readonly SimEntity[];
  /** Deterministic RNG seed. Default 1337. */
  seed?: number;
  /** Tick period in ms. Default 650. */
  intervalMs?: number;
  /** Expected independent single-entity incidents per tick. Default 2. */
  singleRate?: number;
  /** Probability a correlated incident strikes each group level, coarse→fine. */
  groupRates?: readonly number[];
  /** Fraction of a struck group's members affected, per level coarse→fine. */
  groupFractions?: readonly number[];
}

interface SimState {
  id: string;
  baseline: number;
  crit: number;
  mean: number;
  elevated: number;
  resources: readonly string[];
  resSev: Map<string, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}
function drift(rng: () => number, cur: number, mean: number, k: number, vol: number): number {
  const next = cur + (mean - cur) * k + (rng() - 0.5) * vol;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/** Take the last `n` entries of `base`, padding the front with halving values. */
function tail(base: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  if (n <= base.length) return base.slice(base.length - n);
  const out: number[] = [];
  for (let i = 0; i < n - base.length; i++) out.push(base[0] * Math.pow(0.5, n - base.length - i));
  return out.concat(base);
}

const DEFAULT_RATES = [0.02, 0.1, 0.3];
const DEFAULT_FRACTIONS = [0.05, 0.22, 0.7];

export class SimulatedSource implements DataSource {
  readonly name = 'simulated';

  private readonly rng: () => number;
  private readonly intervalMs: number;
  private readonly singleRate: number;
  private readonly groupRates: number[];
  private readonly groupFractions: number[];
  private readonly states: SimState[];
  private readonly levels: Map<string, number[]>[];
  private readonly activeSet = new Set<number>();
  private readonly dataCbs = new Set<DataListener>();
  private readonly stateCbs = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _state: ConnectionState = 'idle';

  constructor(opts: SimulatedSourceOptions) {
    this.rng = mulberry32(opts.seed ?? 1337);
    this.intervalMs = opts.intervalMs ?? 650;
    this.singleRate = opts.singleRate ?? 2;

    const levelCount = opts.entities.reduce((m, e) => Math.max(m, e.groups?.length ?? 0), 0);
    this.groupRates = opts.groupRates ? [...opts.groupRates] : tail(DEFAULT_RATES, levelCount);
    this.groupFractions = opts.groupFractions
      ? [...opts.groupFractions]
      : tail(DEFAULT_FRACTIONS, levelCount);

    this.states = opts.entities.map((e) => {
      const baseline = e.baseline ?? 0.08;
      const resources = e.resources ?? [];
      return {
        id: e.id,
        baseline,
        crit: baseline,
        mean: baseline,
        elevated: 0,
        resources,
        resSev: new Map(resources.map((r) => [r, baseline])),
      };
    });

    this.levels = [];
    for (let l = 0; l < levelCount; l++) {
      const idx = new Map<string, number[]>();
      opts.entities.forEach((e, i) => {
        const key = e.groups?.[l];
        if (key === undefined) return;
        const arr = idx.get(key);
        if (arr) arr.push(i);
        else idx.set(key, [i]);
      });
      this.levels.push(idx);
    }
  }

  onData(listener: DataListener): () => void {
    this.dataCbs.add(listener);
    return () => this.dataCbs.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateCbs.add(listener);
    return () => this.stateCbs.delete(listener);
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  start(): void {
    if (this.timer !== null) return;
    this._setState('open');
    this._seed();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._setState('closed');
  }

  /** Advance one tick synchronously, emit the batch, and return it (for tests). */
  tickOnce(): EntityUpdate[] {
    return this._tick();
  }

  private _setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  private _emit(records: readonly EntityUpdate[]): void {
    for (const cb of this.dataCbs) cb(records);
  }

  private _elevate(i: number, ticks: number, mean: number, anomalies: Map<number, number>): void {
    const s = this.states[i];
    s.elevated = Math.max(s.elevated, ticks);
    s.mean = Math.max(s.mean, mean);
    this.activeSet.add(i);
    anomalies.set(i, Math.max(anomalies.get(i) ?? 0, Math.min(1, mean)));
    for (let k = 0; k < 2 && s.resources.length > 0; k++) {
      const rid = s.resources[Math.floor(this.rng() * s.resources.length)];
      s.resSev.set(rid, randRange(this.rng, 0.6, 1));
    }
  }

  /** Seed a few incidents so the map isn't uniformly healthy on first tick. */
  private _seed(): void {
    const fine = this.levels[this.levels.length - 1];
    if (!fine) return;
    const keys = [...fine.keys()];
    if (keys.length === 0) return;
    const anomalies = new Map<number, number>();
    for (let k = 0; k < 3; k++) {
      const members = fine.get(keys[Math.floor(this.rng() * keys.length)]) ?? [];
      for (const i of members) {
        if (this.rng() < 0.8) {
          this._elevate(i, randInt(this.rng, 14, 26), randRange(this.rng, 0.75, 0.95), anomalies);
        }
      }
    }
  }

  private _tick(): EntityUpdate[] {
    const anomalies = new Map<number, number>();

    // Independent single-entity incidents.
    const singles = randInt(this.rng, 0, Math.max(0, Math.round(this.singleRate * 2)));
    for (let k = 0; k < singles; k++) {
      this._elevate(
        Math.floor(this.rng() * this.states.length),
        randInt(this.rng, 8, 20),
        randRange(this.rng, 0.7, 0.95),
        anomalies,
      );
    }

    // Correlated group incidents: coarse levels are rarer but strike wider.
    for (let l = 0; l < this.levels.length; l++) {
      if (this.rng() >= this.groupRates[l]) continue;
      const keys = [...this.levels[l].keys()];
      if (keys.length === 0) continue;
      const members = this.levels[l].get(keys[Math.floor(this.rng() * keys.length)]) ?? [];
      const frac = this.groupFractions[l];
      for (const i of members) {
        if (this.rng() < frac) {
          this._elevate(i, randInt(this.rng, 12, 30), randRange(this.rng, 0.72, 0.95), anomalies);
        }
      }
    }

    // Drift only the active (elevated / recovering) entities.
    const records: EntityUpdate[] = [];
    for (const i of [...this.activeSet]) {
      const s = this.states[i];
      const rising = s.elevated > 0;
      const mean = rising ? s.mean : s.baseline;
      const prev = s.crit;
      s.crit = drift(this.rng, s.crit, mean, rising ? 0.18 : 0.12, 0.05);
      if (rising) {
        s.elevated--;
        if (s.elevated <= 0) s.mean = s.baseline;
        if (this.rng() < 0.2) anomalies.set(i, Math.max(anomalies.get(i) ?? 0, 0.7));
      }
      const rec: EntityUpdate = { id: s.id, severity: s.crit };
      const a = anomalies.get(i);
      if (a !== undefined) rec.anomaly = a;
      if (s.resources.length > 0) {
        const rs: ResourceUpdate[] = [];
        for (const rid of s.resources) {
          const cur = s.resSev.get(rid) ?? s.baseline;
          const nv = drift(this.rng, cur, rising ? Math.max(s.baseline, 0.5) : s.baseline, 0.1, 0.05);
          s.resSev.set(rid, nv);
          rs.push({ id: rid, value: nv });
        }
        rec.resources = rs;
      }
      records.push(rec);
      if (!rising && Math.abs(s.crit - s.baseline) < 0.01 && Math.abs(prev - s.baseline) < 0.02) {
        s.crit = s.baseline;
        rec.severity = s.baseline;
        this.activeSet.delete(i);
      }
    }

    if (records.length > 0) this._emit(records);
    return records;
  }
}
