import { describe, it, expect } from 'vitest';
import { buildHierarchy, nodesAtDepth, normalizeKey, pathOf, MISSING_KEY, inspectHierarchy } from '../src/shape/hierarchy';

interface Row {
  hub: string;
  sub: string;
  rg: string;
}

const rows: Row[] = [
  { hub: 'krc', sub: 's1', rg: 'net' },
  { hub: 'krc', sub: 's1', rg: 'app' },
  { hub: 'krc', sub: 's2', rg: 'app' },
  { hub: 'krs', sub: 's3', rg: 'data' },
];

const levels = [(r: Row): string => r.hub, (r: Row): string => r.sub, (r: Row): string => r.rg];

describe('hierarchy', () => {
  it('normalizes missing keys to a sentinel instead of dropping rows', () => {
    expect(normalizeKey(null)).toBe(MISSING_KEY);
    expect(normalizeKey(undefined)).toBe(MISSING_KEY);
    expect(normalizeKey('  ')).toBe(MISSING_KEY);
    expect(normalizeKey(' a ')).toBe('a');
    expect(normalizeKey(0)).toBe('0');
  });

  it('extracts a coarse-to-fine path per row', () => {
    expect(pathOf(rows[0], 0, levels)).toEqual(['krc', 's1', 'net']);
  });

  it('builds a tree that loses no rows at any depth', () => {
    const root = buildHierarchy(rows, levels);
    expect(root.size).toBe(4);
    for (let d = 1; d <= 3; d++) {
      const total = nodesAtDepth(root, d).reduce((a, n) => a + n.size, 0);
      expect(total).toBe(4);
    }
  });

  it('groups shared prefixes and keeps first-appearance order', () => {
    const root = buildHierarchy(rows, levels);
    const hubs = nodesAtDepth(root, 1);
    expect(hubs.map((n) => n.key)).toEqual(['krc', 'krs']);
    expect(hubs[0].size).toBe(3);
    const subs = nodesAtDepth(root, 2);
    expect(subs.map((n) => n.key)).toEqual(['s1', 's2', 's3']);
  });

  it('is deterministic for the same input', () => {
    const a = buildHierarchy(rows, levels);
    const b = buildHierarchy(rows, levels);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reports missing keys and skewed levels', () => {
    const skewed = [
      ...Array.from({ length: 100 }, () => ({ hub: 'big', sub: 's', rg: 'r' })),
      { hub: '', sub: 's', rg: 'r' },
      { hub: 'tiny', sub: 's', rg: 'r' },
    ];
    const root = buildHierarchy(skewed, levels);
    const issues = inspectHierarchy(root, ['hub', 'sub', 'rg']);
    expect(issues.some((i) => i.code === 'missing-hierarchy-key')).toBe(true);
    expect(issues.some((i) => i.code === 'unbalanced-level')).toBe(true);
  });
});
