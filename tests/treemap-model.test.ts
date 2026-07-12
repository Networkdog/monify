import { describe, it, expect } from 'vitest';
import {
  buildLiveTree,
  indexById,
  setLeafTarget,
  stepTween,
  computeColors,
} from '../src/viz/treemap/model';
import type { RGBA } from '../src/core/types';

const sample = () =>
  buildLiveTree({
    id: 'root',
    label: 'root',
    value: 0,
    children: [
      { id: 'a', label: 'a', value: 10 },
      {
        id: 'b',
        label: 'b',
        value: 0,
        children: [
          { id: 'b1', label: 'b1', value: 20 },
          { id: 'b2', label: 'b2', value: 10 },
        ],
      },
    ],
  });

describe('buildLiveTree', () => {
  it('derives branch values as the sum of children', () => {
    const root = sample();
    expect(root.target).toBe(40);
    expect(root.children[1].target).toBe(30);
  });
  it('counts descendant leaves', () => {
    const root = sample();
    expect(root.leafCount).toBe(3);
    expect(root.children[1].leafCount).toBe(2);
  });
  it('initializes current to target', () => {
    const root = sample();
    expect(root.current).toBe(root.target);
  });
});

describe('stepTween', () => {
  it('converges leaves toward their new target', () => {
    const root = sample();
    const byId = indexById(root);
    const a = byId.get('a');
    if (!a) throw new Error('node a missing');
    setLeafTarget(a, 100);
    let changed = true;
    for (let i = 0; i < 2000 && changed; i++) changed = stepTween(root, 6, 1 / 60);
    expect(a.current).toBeCloseTo(100, 3);
    // Branch/root reflect the summed change.
    expect(root.current).toBeCloseTo(130, 3);
  });
  it('reports no change once settled', () => {
    const root = sample();
    expect(stepTween(root, 6, 1 / 60)).toBe(false);
  });
});

describe('computeColors', () => {
  it('aggregates a branch as the value-weighted mean of its children', () => {
    const root = sample();
    const colors: Record<string, RGBA> = {
      b1: [1, 0, 0, 1],
      b2: [0, 0, 1, 1],
    };
    computeColors(root, (n) => colors[n.id] ?? [0, 1, 0, 1]);
    const b = root.children[1];
    // b1 (weight 20) red + b2 (weight 10) blue → 2/3 red, 1/3 blue.
    expect(b.color[0]).toBeCloseTo(2 / 3, 5);
    expect(b.color[2]).toBeCloseTo(1 / 3, 5);
  });
});
