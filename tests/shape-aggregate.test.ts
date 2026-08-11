import { describe, it, expect } from 'vitest';
import { aggregate, describe as summarize, rollupTree } from '../src/shape/aggregate';
import { buildHierarchy } from '../src/shape/hierarchy';

describe('aggregate', () => {
  it('computes the basic aggregations', () => {
    const v = [1, 2, 3, 4];
    expect(aggregate(v, 'sum')).toBe(10);
    expect(aggregate(v, 'mean')).toBe(2.5);
    expect(aggregate(v, 'min')).toBe(1);
    expect(aggregate(v, 'max')).toBe(4);
    expect(aggregate(v, 'count')).toBe(4);
    expect(aggregate(v, 'first')).toBe(1);
  });

  it('treats worst as the maximum severity', () => {
    expect(aggregate([0.1, 0.9, 0.3], 'worst')).toBe(0.9);
  });

  it('interpolates percentiles', () => {
    const v = [1, 2, 3, 4, 5];
    expect(aggregate(v, 'p50')).toBe(3);
    expect(aggregate(v, 'p90')).toBeCloseTo(4.6, 6);
  });

  it('weights a weighted mean and falls back when weights are missing', () => {
    expect(aggregate([1, 3], 'weightedMean', [3, 1])).toBe(1.5);
    expect(aggregate([1, 3], 'weightedMean')).toBe(2);
    expect(aggregate([1, 3], 'weightedMean', [0, 0])).toBe(0);
  });

  it('returns 0 for an empty input', () => {
    expect(aggregate([], 'sum')).toBe(0);
    expect(aggregate([], 'worst')).toBe(0);
  });

  it('rolls a measure up every level from the rows themselves', () => {
    const rows = [
      { hub: 'a', sev: 0.1 },
      { hub: 'a', sev: 0.8 },
      { hub: 'b', sev: 0.2 },
    ];
    const tree = buildHierarchy(rows, [(r): string => r.hub]);
    const worst = rollupTree(tree, (i) => rows[i].sev, 'worst');
    expect(worst.get('')).toBeCloseTo(0.8, 6);
    expect(worst.get('a')).toBeCloseTo(0.8, 6);
    expect(worst.get('b')).toBeCloseTo(0.2, 6);
  });

  it('describes a distribution and counts non-finite values', () => {
    const s = summarize([1, 2, 3, NaN, Infinity]);
    expect(s.count).toBe(3);
    expect(s.invalid).toBe(2);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.median).toBe(2);
  });
});
