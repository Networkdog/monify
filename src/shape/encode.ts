// Encoding — binds data fields to visual channels (color, label, size, height,
// centrality, tooltip) and produces the legend that explains the mapping.

import type { RGBA } from '../core/types';
import {
  CATEGORICAL,
  NEUTRAL,
  categorical,
  diverging,
  isDiverging,
  isSequential,
  oklchToRgba,
  paletteStops,
  sampleStops,
  sequential,
} from '../color';
import type { CategoricalName } from '../color';
import type { ResourceLink } from '../viz/hexgrid';
import type { Accessor, LegendEntry, PaletteRef } from './types';

/** Fallback tint for rows outside any known category. */
export const NEUTRAL_TINT: RGBA = NEUTRAL;

/**
 * Hue rotation that never lands twice in the same place — the golden angle is
 * the least-approximable turn, so every new category falls in the widest gap
 * left by the ones before it.
 */
const GOLDEN_ANGLE = 137.507764;
/** Start on the same blue the chrome uses, so category 0 belongs to the theme. */
const HUE_START = 250;
/**
 * A dimension with hundreds of categories runs out of distinguishable hues long
 * before it runs out of categories, so lightness and chroma are cycled
 * underneath the rotation — with different periods, so a hue that does come back
 * around comes back lighter or softer than the first time.
 */
const LIGHTNESS = [0.76, 0.67, 0.84];
const CHROMA = [0.17, 0.11, 0.21];

/** Distinct, stable colour per category index. */
export function categoryColor(index: number): RGBA {
  const i = Math.abs(Math.trunc(index));
  const hue = (i * GOLDEN_ANGLE + HUE_START) % 360;
  const lightness = LIGHTNESS[i % LIGHTNESS.length];
  const chroma = CHROMA[Math.floor(i / LIGHTNESS.length) % CHROMA.length];
  return oklchToRgba(lightness, chroma, hue);
}

/** Swatches 'auto' reaches for before falling back to `categoryColor`. */
const AUTO_SWATCHES = CATEGORICAL.aurora;

export interface CategoryOrderOptions {
  /** Category order: by descending count (default), by name, or an explicit list. */
  order?: 'count' | 'name' | readonly string[];
  /**
   * 'auto' (default) hands the curated `aurora` swatches to a dimension small
   * enough to fit in them and generates hues beyond that; a named palette always
   * cycles its swatches.
   */
  palette?: CategoricalName | 'auto';
}

export interface CategoryScale {
  /** Ordered category keys; index drives hue assignment. */
  keys: string[];
  colorOf: (key: string) => RGBA;
  legend: LegendEntry[];
}

/**
 * Build a categorical color assignment plus its legend. Ordering by descending
 * count means the biggest regions get the most separated hues.
 */
export function buildCategoryScale(
  keys: readonly string[],
  opts: CategoryOrderOptions = {},
): CategoryScale {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);

  let ordered: string[];
  if (Array.isArray(opts.order)) {
    const explicit = opts.order as readonly string[];
    const rest = [...counts.keys()].filter((k) => !explicit.includes(k)).sort();
    ordered = [...explicit.filter((k) => counts.has(k)), ...rest];
  } else if (opts.order === 'name') {
    ordered = [...counts.keys()].sort();
  } else {
    ordered = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k]) => k);
  }

  const palette = opts.palette ?? 'auto';
  // A dimension that fits in the curated palette gets it: hand-picked swatches
  // beat generated ones every time. Past that the palette would start repeating
  // itself, which is worse than a generated hue, so the generator takes over for
  // the whole dimension (mixing the two would make two categories look related
  // when they are not).
  const swatch =
    palette === 'auto'
      ? ordered.length <= AUTO_SWATCHES.length
        ? categorical('aurora')
        : null
      : categorical(palette);
  const colors = new Map<string, RGBA>();
  ordered.forEach((k, i) => colors.set(k, swatch ? swatch(i) : categoryColor(i)));

  const total = keys.length || 1;
  const legend: LegendEntry[] = ordered.map((k) => {
    const count = counts.get(k) ?? 0;
    return { key: k, color: colors.get(k) ?? NEUTRAL_TINT, count, share: count / total };
  });

  return { keys: ordered, colorOf: (k) => colors.get(k) ?? NEUTRAL_TINT, legend };
}

/** Color driven by a numeric measure. */
export interface QuantitativeColor {
  /** Measure name declared on the dataset. */
  by: string;
  /** Palette name; sequential and diverging palettes are both accepted. */
  scale?: PaletteRef;
  domain?: [number, number];
  /** Invert the palette (e.g. so 0 = green and 1 = red for severity). */
  reverse?: boolean;
}

/** Color driven by a categorical dimension. */
export interface CategoricalColor {
  /** Dimension name declared on the dataset. */
  by: string;
  palette?: CategoricalName | 'auto';
  order?: 'count' | 'name' | readonly string[];
  /** Marks this encoding as categorical when a name collides with a measure. */
  type: 'category';
}

export type ColorEncoding = QuantitativeColor | CategoricalColor;

export function isCategoricalColor(c: ColorEncoding): c is CategoricalColor {
  return (c as CategoricalColor).type === 'category';
}

/** Build a value→RGBA scale from a palette reference. */
export function quantitativeScale(
  palette: PaletteRef | undefined,
  domain: [number, number],
  reverse = false,
): (value: number) => RGBA {
  const name = palette && palette !== 'auto' ? palette : 'viridis';
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  if (isSequential(name)) {
    const scale = sequential(name, domain);
    return reverse ? (v) => scale(hi - (v - lo)) : scale;
  }
  if (isDiverging(name)) {
    const stops = paletteStops(name);
    return (v) => {
      const t = (v - lo) / span;
      return sampleStops(stops, reverse ? 1 - t : t);
    };
  }
  const scale = diverging('rdylgn', [lo, (lo + hi) / 2, hi]);
  return reverse ? (v) => scale(hi - (v - lo)) : scale;
}

/** Numeric range mapping used by size / height channels. */
export interface RangeEncoding {
  by: string;
  range?: [number, number];
  domain?: [number, number];
}

/** Pull shared resources toward the middle of their cluster. */
export type CentralEncoding<T> =
  | { by: string; weights: Record<string, number>; fallback?: number }
  | Accessor<T, number>;

/** Tooltip lines: field names to show, or a builder for full control. */
export type TooltipEncoding<T> = readonly string[] | Accessor<T, string[]>;

/** Sub-metrics shown when a cell is zoomed into. */
export interface ResourceValue {
  id: string;
  value: number;
}

export interface EncodingSpec<T> {
  /** Hierarchy levels used for layout, coarse→fine. Defaults to every level. */
  layout?: readonly string[];
  /** Live severity driving the health colour. Defaults to a quantitative `color`. */
  status?: { by: string };
  color?: ColorEncoding;
  size?: RangeEncoding;
  height?: RangeEncoding;
  label?: Accessor<T, string> | string;
  central?: CentralEncoding<T>;
  tooltip?: TooltipEncoding<T>;
  /** Ids of related rows — the magnetic links of a 'relational' placement. Return `{ id, kind }` to have each link drawn in its kind's own wire style. */
  links?: Accessor<T, ResourceLink[]>;
  /** A key shared with the clusters this row should gather near — the hub a subscription peers with, for a 'force' placement. */
  anchor?: Accessor<T, string>;
  /** Non-containment attributes whose siblings attract; dimension names or a builder. */
  affinity?: readonly string[] | Accessor<T, string[]>;
  /** Per-row sub-metrics for deep-zoom detail. */
  resources?: Accessor<T, ResourceValue[]>;
  /** Rows for which no status is reported (drawn neutral, excluded from rollups). */
  monitored?: Accessor<T, boolean>;
}

/** Map a value from `domain` into `range`, clamped. */
export function mapRange(
  value: number,
  domain: [number, number],
  range: [number, number],
): number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const t = span === 0 ? 0 : (value - d0) / span;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return r0 + (r1 - r0) * clamped;
}
