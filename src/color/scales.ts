// Color scale functions that map data values to engine RGBA colors.
//
// A "scale" is a function from a data value to an RGBA color. Sequential and
// diverging scales interpolate between palette stops; categorical scales index
// into a fixed set of hues. All colors are returned in the engine's RGBA
// format ([r, g, b, a] with components in 0..1).

import type { RGBA } from '../core/types';
import {
  SEQUENTIAL,
  DIVERGING,
  CATEGORICAL,
  type SequentialName,
  type DivergingName,
  type CategoricalName,
} from './palettes';

/** Anything accepted where a color is expected. */
export type ColorInput = string | RGBA | readonly [number, number, number];

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Parse a `#rgb` / `#rrggbb` hex string into engine RGBA. */
export function hexToRgba(hex: string, alpha = 1): RGBA {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  return [r, g, b, alpha];
}

/** Linear interpolation between two RGBA colors in sRGB space. */
export function interpolateRgb(a: RGBA, b: RGBA, t: number): RGBA {
  const u = 1 - t;
  return [a[0] * u + b[0] * t, a[1] * u + b[1] * t, a[2] * u + b[2] * t, a[3] * u + b[3] * t];
}

/** Oklab → linear sRGB (Björn Ottosson's matrices). */
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function encodeSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function decodeSrgb(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Engine RGBA → OKLCH `[lightness, chroma, hue°]`. Inverse of `oklchToRgba`. */
export function rgbaToOklch(color: RGBA): [number, number, number] {
  const r = decodeSrgb(color[0]);
  const g = decodeSrgb(color[1]);
  const b = decodeSrgb(color[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return [lightness, Math.hypot(a, bb), hue < 0 ? hue + 360 : hue];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  return r >= -1e-4 && r <= 1 + 1e-4 && g >= -1e-4 && g <= 1 + 1e-4 && b >= -1e-4 && b <= 1 + 1e-4;
}

/**
 * OKLCH → engine RGBA, the color space CSS Color 4 and every recent design
 * system state their palettes in. Lightness and chroma are perceptual there, so
 * holding them fixed while rotating the hue gives colors that all read as
 * equally strong — which HSL, where yellow comes out far brighter than blue at
 * the same `l`, does not.
 *
 * Chroma is reduced (hue and lightness preserved) until the color fits in sRGB,
 * the standard gamut-mapping fallback, rather than clipping channels — clipping
 * would swing the hue on exactly the vivid colors that need it most.
 *
 * @param lightness Perceptual lightness, 0..1.
 * @param chroma    Colorfulness; ~0.37 is the most sRGB can hold anywhere.
 * @param hue       Hue angle in degrees.
 */
export function oklchToRgba(lightness: number, chroma: number, hue: number, alpha = 1): RGBA {
  const rad = (hue * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  let lo = 0;
  let hi = chroma;
  let rgb = oklabToLinearSrgb(lightness, chroma * ca, chroma * sa);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const probe = oklabToLinearSrgb(lightness, mid * ca, mid * sa);
      if (inGamut(probe)) {
        lo = mid;
        rgb = probe;
      } else {
        hi = mid;
      }
    }
  }
  return [clamp01(encodeSrgb(rgb[0])), clamp01(encodeSrgb(rgb[1])), clamp01(encodeSrgb(rgb[2])), alpha];
}

/** Resolve a flexible color input into engine RGBA. */
export function resolveColor(input: ColorInput, alpha = 1): RGBA {
  if (typeof input === 'string') return hexToRgba(input, alpha);
  if (input.length === 3) return [input[0], input[1], input[2], alpha];
  return [input[0], input[1], input[2], input[3]];
}

/** Convert a list of hex stops into RGBA stops. */
function toStops(hex: readonly string[], alpha: number): RGBA[] {
  return hex.map((h) => hexToRgba(h, alpha));
}

/** Sample a piecewise-linear gradient of RGBA stops at t ∈ [0, 1]. */
export function sampleStops(stops: readonly RGBA[], t: number): RGBA {
  const n = stops.length - 1;
  if (n <= 0) return stops[0];
  const scaled = clamp01(t) * n;
  const i = Math.min(Math.floor(scaled), n - 1);
  return interpolateRgb(stops[i], stops[i + 1], scaled - i);
}

/** A scale mapping a numeric value to an RGBA color. */
export type ColorScale = (value: number) => RGBA;

/**
 * Sequential scale: maps `domain[0]..domain[1]` onto the palette from its low
 * to high end. Values outside the domain are clamped.
 */
export function sequential(
  name: SequentialName,
  domain: readonly [number, number] = [0, 1],
  alpha = 1,
): ColorScale {
  const stops = toStops(SEQUENTIAL[name], alpha);
  const [d0, d1] = domain;
  const span = d1 - d0 || 1;
  return (value: number) => sampleStops(stops, (value - d0) / span);
}

/**
 * Diverging scale: maps a value onto a palette with a meaningful midpoint.
 * `domain` is `[low, mid, high]`; `mid` lands on the neutral center stop.
 */
export function diverging(
  name: DivergingName,
  domain: readonly [number, number, number] = [-1, 0, 1],
  alpha = 1,
): ColorScale {
  const stops = toStops(DIVERGING[name], alpha);
  const [lo, mid, hi] = domain;
  const loSpan = mid - lo || 1;
  const hiSpan = hi - mid || 1;
  return (value: number) => {
    const t =
      value < mid ? 0.5 * ((value - lo) / loSpan) : 0.5 + 0.5 * ((value - mid) / hiSpan);
    return sampleStops(stops, t);
  };
}

/** Categorical scale: maps an integer index to a hue (wraps modulo length). */
export function categorical(name: CategoricalName, alpha = 1): (index: number) => RGBA {
  const stops = toStops(CATEGORICAL[name], alpha);
  return (index: number) => stops[((index % stops.length) + stops.length) % stops.length];
}

/** Return the RGBA stops of any named palette (useful for legends). */
export function paletteStops(
  name: SequentialName | DivergingName | CategoricalName,
  alpha = 1,
): RGBA[] {
  if (name in SEQUENTIAL) return toStops(SEQUENTIAL[name as SequentialName], alpha);
  if (name in DIVERGING) return toStops(DIVERGING[name as DivergingName], alpha);
  return toStops(CATEGORICAL[name as CategoricalName], alpha);
}
