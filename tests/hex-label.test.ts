import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  fitLabel,
  labelCapacity,
  labelColorFor,
  labelWorldSize,
  relativeLuminance,
  HEX_WIDTH_RATIO,
  LABEL_CHAR_EM,
  LABEL_MAX_CHARS,
  LABEL_MIN_CONTRAST,
  LABEL_TARGET_CONTRAST,
  LABEL_PAD,
} from '../src/viz/hexgrid/label';
import { CATEGORICAL } from '../src/color/palettes';
import { hexToRgba, paletteStops, rgbaToOklch, sampleStops } from '../src/color';
import type { RGBA } from '../src/core/types';

/** Every colour a cell can actually take: the status ramp plus the tint swatches. */
function cellFills(): RGBA[] {
  const stops = paletteStops('status');
  const fills: RGBA[] = [];
  for (let i = 0; i <= 100; i++) fills.push(sampleStops(stops, i / 100));
  for (const hex of CATEGORICAL.aurora) fills.push(hexToRgba(hex));
  return fills;
}

describe('label contrast', () => {
  it('never uses pure black or pure white', () => {
    for (const fill of cellFills()) {
      const c = labelColorFor(fill);
      expect(c[0] === 0 && c[1] === 0 && c[2] === 0).toBe(false);
      expect(c[0] === 1 && c[1] === 1 && c[2] === 1).toBe(false);
    }
  });

  it('computes WCAG relative luminance at the known anchors', () => {
    expect(relativeLuminance([0, 0, 0, 1])).toBeCloseTo(0, 6);
    expect(relativeLuminance([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(contrastRatio([0, 0, 0, 1], [1, 1, 1, 1])).toBeCloseTo(21, 4);
  });

  it('clears WCAG AA against the cell itself, with no outline to lean on', () => {
    for (const fill of cellFills()) {
      const ratio = contrastRatio(labelColorFor(fill), fill);
      expect(ratio, `fill ${JSON.stringify(fill)}`).toBeGreaterThanOrEqual(LABEL_MIN_CONTRAST);
    }
  });

  it('keeps the cell’s own hue instead of dropping to a neutral', () => {
    for (const hex of CATEGORICAL.aurora) {
      const fill = hexToRgba(hex);
      const [, , fillHue] = rgbaToOklch(fill);
      const [, glyphChroma, glyphHue] = rgbaToOklch(labelColorFor(fill));
      expect(glyphChroma, `chroma on ${hex}`).toBeGreaterThan(0.01);
      const drift = Math.abs(((glyphHue - fillHue + 540) % 360) - 180);
      expect(drift, `hue drift on ${hex}`).toBeLessThan(20);
    }
  });

  it('goes dark on light fills and light on dark fills', () => {
    const light: RGBA = [0.95, 0.95, 0.9, 1];
    const dark: RGBA = [0.15, 0.1, 0.12, 1];
    expect(relativeLuminance(labelColorFor(light))).toBeLessThan(relativeLuminance(light));
    expect(relativeLuminance(labelColorFor(dark))).toBeGreaterThan(relativeLuminance(dark));
  });

  it('travels no further than it has to', () => {
    // A light cell gets a tone of itself, not the darkest ink available.
    const fill: RGBA = [0.85, 0.85, 0.85, 1];
    const ratio = contrastRatio(labelColorFor(fill), fill);
    expect(ratio).toBeGreaterThanOrEqual(LABEL_TARGET_CONTRAST);
    expect(ratio).toBeLessThan(LABEL_TARGET_CONTRAST + 0.5);
  });
});

describe('label fitting', () => {
  it('reserves padding on both sides of the cell', () => {
    const cellPx = 100;
    const usable = cellPx * HEX_WIDTH_RATIO * (1 - 2 * LABEL_PAD);
    // 20% padding per side leaves 60% of the hexagon's flat-to-flat width.
    expect(usable / (cellPx * HEX_WIDTH_RATIO)).toBeCloseTo(0.6, 6);
  });

  it('scales the glyph with the cell instead of floating at a fixed size', () => {
    expect(labelWorldSize(2)).toBeCloseTo(2 * labelWorldSize(1), 6);
  });

  it('sizes the glyph so a full-length label still clears the padding', () => {
    const worldRadius = 1;
    const usableWidth = 2 * worldRadius * HEX_WIDTH_RATIO * (1 - 2 * LABEL_PAD);
    const textWidth = LABEL_MAX_CHARS * LABEL_CHAR_EM * labelWorldSize(worldRadius);
    expect(textWidth).toBeLessThanOrEqual(usableWidth + 1e-9);
    // The budget is spent, not wasted: it fills the usable width.
    expect(textWidth / usableWidth).toBeCloseTo(1, 6);
  });

  it('keeps capacity constant, since the label grows with the cell', () => {
    expect(labelCapacity()).toBe(LABEL_MAX_CHARS);
  });

  it('keeps short labels untouched', () => {
    expect(fitLabel('VM', 4)).toBe('VM');
    expect(fitLabel('VMSS', 4)).toBe('VMSS');
  });

  it('truncates with an ellipsis instead of shrinking', () => {
    expect(fitLabel('STORAGE', 4)).toBe('STO…');
    expect(fitLabel('STORAGE', 4)?.length).toBe(4);
  });

  it('drops the label when even a truncated glyph would crowd the cell', () => {
    expect(fitLabel('VM', 1)).toBeNull();
    expect(fitLabel('VM', 0)).toBeNull();
    expect(fitLabel('', 5)).toBeNull();
  });

  it('fits a 4-character type code', () => {
    expect(labelCapacity()).toBeGreaterThanOrEqual(4);
  });
});
