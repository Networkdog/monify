import { describe, it, expect } from 'vitest';
import {
  hexToRgba,
  interpolateRgb,
  sampleStops,
  sequential,
  diverging,
  categorical,
  resolveColor,
} from '../src/color/scales';
import { SEQUENTIAL, DIVERGING, CATEGORICAL } from '../src/color/palettes';
import type { RGBA } from '../src/core/types';

const approx = (a: RGBA, b: RGBA, eps = 1e-6): void => {
  for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};

describe('hexToRgba', () => {
  it('parses long and short hex', () => {
    approx(hexToRgba('#ffffff'), [1, 1, 1, 1]);
    approx(hexToRgba('#000000'), [0, 0, 0, 1]);
    approx(hexToRgba('#f00'), [1, 0, 0, 1]);
  });
  it('applies alpha', () => {
    expect(hexToRgba('#000000', 0.5)[3]).toBe(0.5);
  });
});

describe('interpolateRgb', () => {
  it('is linear', () => {
    approx(interpolateRgb([0, 0, 0, 0], [1, 1, 1, 1], 0.5), [0.5, 0.5, 0.5, 0.5]);
  });
});

describe('sampleStops', () => {
  const stops: RGBA[] = [
    [0, 0, 0, 1],
    [1, 1, 1, 1],
  ];
  it('clamps out-of-range t', () => {
    approx(sampleStops(stops, -5), [0, 0, 0, 1]);
    approx(sampleStops(stops, 5), [1, 1, 1, 1]);
  });
  it('interpolates', () => {
    approx(sampleStops(stops, 0.25), [0.25, 0.25, 0.25, 1]);
  });
});

describe('sequential', () => {
  it('maps domain endpoints to palette ends', () => {
    const s = sequential('viridis', [0, 100]);
    approx(s(0), hexToRgba(SEQUENTIAL.viridis[0]));
    approx(s(100), hexToRgba(SEQUENTIAL.viridis[SEQUENTIAL.viridis.length - 1]));
  });
  it('clamps beyond the domain', () => {
    const s = sequential('inferno', [0, 1]);
    approx(s(-10), hexToRgba(SEQUENTIAL.inferno[0]));
    approx(s(10), hexToRgba(SEQUENTIAL.inferno[SEQUENTIAL.inferno.length - 1]));
  });
});

describe('diverging', () => {
  it('lands the midpoint on the neutral center stop', () => {
    const d = diverging('rdbu', [-1, 0, 1]);
    approx(d(0), hexToRgba(DIVERGING.rdbu[5]));
    approx(d(-1), hexToRgba(DIVERGING.rdbu[0]));
    approx(d(1), hexToRgba(DIVERGING.rdbu[DIVERGING.rdbu.length - 1]));
  });
});

describe('categorical', () => {
  it('indexes and wraps modulo length', () => {
    const c = categorical('tableau10');
    approx(c(0), hexToRgba(CATEGORICAL.tableau10[0]));
    approx(c(CATEGORICAL.tableau10.length), hexToRgba(CATEGORICAL.tableau10[0]));
    approx(c(-1), hexToRgba(CATEGORICAL.tableau10[CATEGORICAL.tableau10.length - 1]));
  });
});

describe('resolveColor', () => {
  it('accepts hex, rgb, and rgba', () => {
    approx(resolveColor('#ff0000'), [1, 0, 0, 1]);
    approx(resolveColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
    approx(resolveColor([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4]);
  });
});
