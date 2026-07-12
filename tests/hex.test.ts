import { describe, it, expect } from 'vitest';
import {
  axialToPixel,
  pixelToAxial,
  hexRound,
  hexNeighbors,
  hexDistance,
  hexRing,
  hexSpiral,
  spiralCount,
  spiralRadiusFor,
  hexPolygon,
} from '../src/viz/hexgrid/hex';

describe('axial ↔ pixel', () => {
  it('round-trips through hexRound', () => {
    for (let q = -5; q <= 5; q++) {
      for (let r = -5; r <= 5; r++) {
        const [px, py] = axialToPixel(q, r, 1);
        const [fq, fr] = pixelToAxial(px, py, 1);
        expect(hexRound(fq, fr)).toEqual([q, r]);
      }
    }
  });
  it('scales linearly with size', () => {
    const [x1] = axialToPixel(2, 1, 1);
    const [x2] = axialToPixel(2, 1, 3);
    expect(x2).toBeCloseTo(x1 * 3, 9);
  });
});

describe('neighbors & distance', () => {
  it('has six neighbors all at distance 1', () => {
    const nbrs = hexNeighbors(0, 0);
    expect(nbrs).toHaveLength(6);
    for (const [q, r] of nbrs) expect(hexDistance(0, 0, q, r)).toBe(1);
  });
});

describe('rings & spirals', () => {
  it('ring radius 0 is the origin', () => {
    expect(hexRing(0)).toEqual([[0, 0]]);
  });
  it('ring size is 6 * radius', () => {
    expect(hexRing(1)).toHaveLength(6);
    expect(hexRing(3)).toHaveLength(18);
  });
  it('spiral count matches formula', () => {
    expect(spiralCount(0)).toBe(1);
    expect(spiralCount(1)).toBe(7);
    expect(spiralCount(2)).toBe(19);
    expect(hexSpiral(2)).toHaveLength(19);
  });
  it('spiralRadiusFor picks the smallest fitting radius', () => {
    expect(spiralRadiusFor(1)).toBe(0);
    expect(spiralRadiusFor(7)).toBe(1);
    expect(spiralRadiusFor(8)).toBe(2);
  });
  it('spiral cells are all unique', () => {
    const cells = hexSpiral(4);
    const keys = new Set(cells.map(([q, r]) => `${q},${r}`));
    expect(keys.size).toBe(cells.length);
  });
});

describe('hexPolygon', () => {
  it('returns six vertices (12 coordinates)', () => {
    const poly = hexPolygon(0, 0, 1);
    expect(poly).toHaveLength(12);
  });
  it('places vertices at the circumradius', () => {
    const poly = hexPolygon(0, 0, 2);
    for (let i = 0; i < 6; i++) {
      const d = Math.hypot(poly[i * 2], poly[i * 2 + 1]);
      expect(d).toBeCloseTo(2, 9);
    }
  });
});
