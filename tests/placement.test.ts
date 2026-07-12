import { describe, it, expect } from 'vitest';
import { HexPlacer, hashString } from '../src/viz/hexgrid/placement';
import { hexNeighbors, axialKey, type Axial } from '../src/viz/hexgrid/hex';

const NAMES = Array.from({ length: 120 }, (_, i) => `svc-${(i % 7)}-${i}`);

function placeAll(sizes: (name: string) => number): Axial[][] {
  const placer = new HexPlacer(30);
  return NAMES.map((n) => placer.place(n, sizes(n)).cells);
}

function isContiguous(cells: Axial[]): boolean {
  if (cells.length <= 1) return true;
  const set = new Set(cells.map(([q, r]) => axialKey(q, r)));
  const seen = new Set<string>();
  const stack: Axial[] = [cells[0]];
  while (stack.length) {
    const [q, r] = stack.pop() as Axial;
    const key = axialKey(q, r);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [nq, nr] of hexNeighbors(q, r)) {
      const nk = axialKey(nq, nr);
      if (set.has(nk) && !seen.has(nk)) stack.push([nq, nr]);
    }
  }
  return seen.size === cells.length;
}

describe('hashString', () => {
  it('is deterministic', () => {
    expect(hashString('payments-01')).toBe(hashString('payments-01'));
  });
  it('differs for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});

describe('HexPlacer', () => {
  it('is deterministic for the same names in the same order', () => {
    const a = placeAll(() => 1);
    const b = placeAll(() => 1);
    expect(a).toEqual(b);
  });

  it('never places two workloads on the same cell', () => {
    const all = placeAll((n) => (n.endsWith('3') ? 3 : 1)).flat();
    const keys = all.map(([q, r]) => axialKey(q, r));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('claims a contiguous cluster for multi-cell workloads', () => {
    const placer = new HexPlacer(30);
    const big = placer.place('whale', 4);
    expect(big.cells).toHaveLength(4);
    expect(isContiguous(big.cells)).toBe(true);
  });

  it('keeps every multi-cell workload contiguous even when crowded', () => {
    const clusters = placeAll((n) => (n.charCodeAt(n.length - 1) % 3) + 1);
    for (const cells of clusters) expect(isContiguous(cells)).toBe(true);
  });
});
