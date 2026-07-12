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
