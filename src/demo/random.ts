// Small deterministic helpers for demo data generation and realistic drift.

/** Seedable PRNG (mulberry32) → function returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1));
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export interface DriftParams {
  min: number;
  max: number;
  /** Value the walk is pulled toward. */
  mean: number;
  /** Fraction of the gap to the mean closed per step (0..1). */
  reversion: number;
  /** Random shock magnitude as a fraction of (max - min). */
  volatility: number;
}

/**
 * One step of a bounded, mean-reverting random walk — the kind of motion that
 * looks like a real metric wandering around a baseline with occasional shocks.
 */
export function drift(value: number, p: DriftParams, rng: () => number): number {
  const pull = (p.mean - value) * p.reversion;
  const shock = (rng() * 2 - 1) * p.volatility * (p.max - p.min);
  const next = value + pull + shock;
  return Math.max(p.min, Math.min(p.max, next));
}
