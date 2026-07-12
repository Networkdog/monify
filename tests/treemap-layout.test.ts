import { describe, it, expect } from 'vitest';
import { squarify, insetRect, layoutTree } from '../src/viz/treemap/layout';
import { buildLiveTree } from '../src/viz/treemap/model';
import type { Rect } from '../src/viz/treemap/model';

const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

function overlaps(a: Rect, b: Rect): boolean {
  const eps = 1e-9;
  return a.x0 < b.x1 - eps && a.x1 > b.x0 + eps && a.y0 < b.y1 - eps && a.y1 > b.y0 + eps;
}

const UNIT: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };

describe('squarify', () => {
  it('tiles the parent rect exactly (areas sum to parent area)', () => {
    const rects = squarify([3, 2, 1, 1, 5, 4], UNIT);
    const sum = rects.reduce((s, r) => s + area(r), 0);
    expect(Math.abs(sum - area(UNIT))).toBeLessThan(1e-6);
  });

  it('produces non-overlapping rects', () => {
    const rects = squarify([5, 3, 2, 2, 1, 4, 6], UNIT);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('makes area proportional to weight', () => {
    const weights = [4, 2, 1, 1];
    const rects = squarify(weights, UNIT);
    const total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      expect(Math.abs(area(rects[i]) - weights[i] / total)).toBeLessThan(1e-6);
    }
  });

  it('keeps every rect inside the parent', () => {
    const rects = squarify([1, 2, 3, 4, 5], UNIT);
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y0).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x1).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y1).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('is deterministic', () => {
    const a = squarify([3, 1, 4, 1, 5, 9, 2], UNIT);
    const b = squarify([3, 1, 4, 1, 5, 9, 2], UNIT);
    expect(a).toEqual(b);
  });

  it('handles zero weights as degenerate rects', () => {
    const rects = squarify([0, 2, 0, 3], UNIT);
    expect(area(rects[0])).toBe(0);
    expect(area(rects[2])).toBe(0);
    expect(Math.abs(area(rects[1]) + area(rects[3]) - 1)).toBeLessThan(1e-6);
  });
});

describe('insetRect', () => {
  it('shrinks by pad on every side', () => {
    const r = insetRect(UNIT, 0.1);
    expect(r).toEqual({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 });
  });
  it('never inverts past center', () => {
    const r = insetRect({ x0: 0, y0: 0, x1: 1, y1: 0.2 }, 0.5);
    expect(r.y0).toBeLessThanOrEqual(r.y1);
  });
});

describe('layoutTree', () => {
  it('assigns child rects inside their parent and keeps them disjoint', () => {
    const root = buildLiveTree({
      id: 'root',
      label: 'root',
      value: 0,
      children: [
        { id: 'a', label: 'a', value: 3, children: [
          { id: 'a1', label: 'a1', value: 1 },
          { id: 'a2', label: 'a2', value: 2 },
        ] },
        { id: 'b', label: 'b', value: 2 },
        { id: 'c', label: 'c', value: 1 },
      ],
    });
    layoutTree(root, { ...UNIT });
    // Top-level children partition the world (children fill their parent).
    const kids = root.children.map((c) => c.rect);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        expect(overlaps(kids[i], kids[j])).toBe(false);
      }
    }
    // Grandchildren sit inside their parent.
    const a = root.children[0];
    for (const gc of a.children) {
      expect(gc.rect.x0).toBeGreaterThanOrEqual(a.rect.x0 - 1e-9);
      expect(gc.rect.x1).toBeLessThanOrEqual(a.rect.x1 + 1e-9);
      expect(gc.rect.y0).toBeGreaterThanOrEqual(a.rect.y0 - 1e-9);
      expect(gc.rect.y1).toBeLessThanOrEqual(a.rect.y1 + 1e-9);
    }
  });
});
