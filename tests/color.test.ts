import { describe, it, expect } from 'vitest';
import {
  hexToRgba,
  interpolateRgb,
  oklchToRgba,
  sampleStops,
  sequential,
  diverging,
  categorical,
  resolveColor,
} from '../src/color/scales';
import { SEQUENTIAL, DIVERGING, CATEGORICAL } from '../src/color/palettes';
import { categoryColor } from '../src/shape/encode';
import { relativeLuminance } from '../src/viz/hexgrid/label';
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

describe('oklchToRgba', () => {
  it('maps the achromatic ends onto black and white', () => {
    approx(oklchToRgba(0, 0, 0), [0, 0, 0, 1], 1e-6);
    approx(oklchToRgba(1, 0, 0), [1, 1, 1, 1], 1e-6);
  });

  it('gamut-maps an impossible chroma instead of clipping the hue away', () => {
    // No sRGB color is this colorful; chroma is reduced until one fits.
    const c = oklchToRgba(0.7, 0.9, 30);
    for (let i = 0; i < 3; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(0);
      expect(c[i]).toBeLessThanOrEqual(1);
    }
    // Hue 30° is orange-red: the channels must still rank r > g > b.
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[1]).toBeGreaterThan(c[2]);
  });
});

describe('status ramp', () => {
  const stops = DIVERGING.status.map((h) => hexToRgba(h));

  it('runs critical → healthy', () => {
    // Sampled with (1 - severity), so index 0 is what severity 1.0 lands on.
    const crit = stops[0];
    const healthy = stops[stops.length - 1];
    expect(crit[0]).toBeGreaterThan(crit[1]); // red-dominant
    expect(healthy[1]).toBeGreaterThan(healthy[0]); // green-dominant
  });

  it('settles down at the healthy end so incidents are the loud thing', () => {
    const healthy = relativeLuminance(stops[stops.length - 1]);
    const mid = relativeLuminance(stops[(stops.length - 1) / 2]);
    const crit = relativeLuminance(stops[0]);
    expect(healthy).toBeLessThan(crit);
    expect(healthy).toBeLessThan(mid);
  });
});

describe('categoryColor', () => {
  const many = Array.from({ length: 64 }, (_, i) => categoryColor(i));

  it('is stable per index', () => {
    expect(categoryColor(7)).toEqual(categoryColor(7));
  });

  it('keeps every category equally loud', () => {
    // The point of OKLCH over HSL: no category is nearly invisible on the dark
    // canvas, and none blows out to near white.
    for (const c of many) {
      const lum = relativeLuminance(c);
      expect(lum).toBeGreaterThan(0.1);
      expect(lum).toBeLessThan(0.9);
    }
  });

  it('gives neighbouring categories separated colors', () => {
    for (let i = 1; i < many.length; i++) {
      const d =
        Math.abs(many[i][0] - many[i - 1][0]) +
        Math.abs(many[i][1] - many[i - 1][1]) +
        Math.abs(many[i][2] - many[i - 1][2]);
      expect(d, `index ${i}`).toBeGreaterThan(0.15);
    }
  });
});
