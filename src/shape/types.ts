// Shared types for the shape toolkit — the declarative spec that turns user
// rows into cell + layer data.

import type { CategoricalName, DivergingName, SequentialName } from '../color';

/** Reads a value out of one user row. */
export type Accessor<T, V> = (row: T, index: number) => V;

/** How a set of values collapses into one number when rolled up a level. */
export type AggName =
  | 'sum'
  | 'mean'
  | 'min'
  | 'max'
  | 'count'
  | 'worst'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'first'
  | 'weightedMean';

/** A numeric field plus how it aggregates. */
export interface MeasureSpec<T> {
  value: Accessor<T, number>;
  /** Default 'mean' (use 'worst' for severity, which takes the max). */
  agg?: AggName;
  /** Fixed scale domain; inferred from the data when omitted. */
  domain?: [number, number];
  label?: string;
  /** Weights for `agg: 'weightedMean'`. */
  weight?: Accessor<T, number>;
}

/** A categorical field used for grouping, coloring, and legends. */
export interface DimensionSpec<T> {
  of: Accessor<T, string>;
  label?: string;
  /** 'auto' (default) spreads distinct hues by golden angle. */
  palette?: CategoricalName | 'auto';
  /** Category order: by descending count (default), by name, or an explicit list. */
  order?: 'count' | 'name' | readonly string[];
}

/** The declarative description of a user dataset. */
export interface DatasetSpec<T> {
  data: readonly T[];
  /** Stable identity, used to route live updates. Must be unique per row. */
  id: Accessor<T, string>;
  label?: Accessor<T, string>;
  /** Containment levels coarse→fine; property order defines the hierarchy. */
  hierarchy?: Record<string, Accessor<T, string>>;
  measures?: Record<string, MeasureSpec<T>>;
  dimensions?: Record<string, DimensionSpec<T>>;
  meta?: Accessor<T, Record<string, unknown>>;
}

/** Any palette name accepted by a color encoding. */
export type PaletteRef = SequentialName | DivergingName | CategoricalName | 'auto';

/** One entry of a categorical legend. */
export interface LegendEntry {
  key: string;
  color: [number, number, number, number];
  count: number;
  /** Fraction of all rows, 0..1. */
  share: number;
}

/** A problem found while validating a spec or profiling data. */
export interface Issue {
  /** 'error' blocks a correct render; 'warning' is a quality smell. */
  level: 'error' | 'warning';
  /** Stable machine-readable code, e.g. 'duplicate-id'. */
  code: string;
  message: string;
  /** Where it applies (field name, level name, row id…). */
  subject?: string;
  /** A few offending samples, for actionable messages. */
  samples?: string[];
}
