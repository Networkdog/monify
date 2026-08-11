// Aggregation — collapses many row values into one number per group, and rolls
// that up through the hierarchy so every zoom layer has a value.

import type { HierarchyNode } from './hierarchy';
import { pathKey } from './hierarchy';
import type { AggName } from './types';

/** Linear-interpolated percentile of an unsorted list. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Collapse values with the named aggregation. `weights` is used by weightedMean. */
export function aggregate(
  values: readonly number[],
  agg: AggName,
  weights?: readonly number[],
): number {
  if (values.length === 0) return 0;
  switch (agg) {
    case 'count':
      return values.length;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    // A group is as unhealthy as its worst member.
    case 'max':
    case 'worst':
      return Math.max(...values);
    case 'first':
      return values[0];
    case 'p50':
      return percentile(values, 0.5);
    case 'p90':
      return percentile(values, 0.9);
    case 'p95':
      return percentile(values, 0.95);
    case 'p99':
      return percentile(values, 0.99);
    case 'weightedMean': {
      if (!weights || weights.length !== values.length) {
        return values.reduce((a, b) => a + b, 0) / values.length;
      }
      let num = 0;
      let den = 0;
      for (let i = 0; i < values.length; i++) {
        num += values[i] * weights[i];
        den += weights[i];
      }
      return den === 0 ? 0 : num / den;
    }
  }
}

/**
 * Aggregate every node of the tree, keyed by path. Nodes aggregate their own
 * rows directly, which keeps non-decomposable aggregations (percentiles,
 * worst) exact instead of averaging already-averaged children.
 */
export function rollupTree(
  root: HierarchyNode,
  valueOf: (rowIndex: number) => number,
  agg: AggName,
  weightOf?: (rowIndex: number) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: HierarchyNode): void => {
    const values = node.rows.map(valueOf);
    const weights = weightOf ? node.rows.map(weightOf) : undefined;
    out.set(pathKey(node.path), aggregate(values, agg, weights));
    for (const c of node.children) walk(c);
  };
  walk(root);
  return out;
}

export interface MeasureStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  count: number;
  /** Rows whose value was NaN or non-finite. */
  invalid: number;
}

/** Summary statistics used for scale domains and profiling. */
export function describe(values: readonly number[]): MeasureStats {
  const finite = values.filter((v) => Number.isFinite(v));
  const invalid = values.length - finite.length;
  if (finite.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, count: 0, invalid };
  }
  return {
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: finite.reduce((a, b) => a + b, 0) / finite.length,
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    count: finite.length,
    invalid,
  };
}
